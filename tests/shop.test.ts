import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder, priceCart, updateProduct } from "@/lib/services/shop";
import { cancelOrder, expireIfDue, fulfillOrder, getOrder, getPaymentSetupStatus, markOrderPaid, savePaymentAccount, verifyPaymentAccount } from "@/lib/services/orders";
import { ORDER_TRANSITIONS, canTransition } from "@/lib/shop/machine";
import { handleCheckout } from "@/lib/shop-routes";
import type { Store, TenantRow } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";
import type { PchomepayClient } from "@/lib/pay/pchomepay";
import { makeShop } from "./shop-helpers";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
});

const contact = { name: "王小明", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "王小明", phone: "0912345678", address: "台北市信義區市府路 1 號" };


const mailer = () => {
  const sent: { to: string; subject: string }[] = [];
  return { sent, sendMail: async (to: string, subject: string) => void sent.push({ to, subject }) };
};

function orderInput(items: unknown, extra: Record<string, unknown> = {}) {
  return { items, contact, shipping, paymentMethod: "offline", ...extra };
}

describe("商品上架門檻（比照文章）", () => {
  it("直接上架需要 publish scope＋confirm；修改已上架商品也要", async () => {
    const store = newStore();
    const { tenant, mug } = await makeShop(store, "gate-shop");
    const writer = ctxFor(store, { kind: "token", label: "t", tenantId: tenant.id, scopes: ["commerce:write"] } as Actor);
    await expect(createProduct(writer, { slug: "x1", name: "X", price: 10, status: "published", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    const draft = await createProduct(writer, { slug: "x2", name: "X", price: 10 });
    expect(draft.status).toBe("draft");
    await expect(updateProduct(writer, { productId: mug.id, patch: { price: 1 } })).rejects.toMatchObject({ code: "forbidden" });
    const pub = ctxFor(store, { kind: "token", label: "t", tenantId: tenant.id, scopes: ["commerce:write", "publish"] } as Actor);
    await expect(updateProduct(pub, { productId: mug.id, patch: { price: 1 } })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(createProduct(ctxFor(store, { kind: "token", label: "t", tenantId: tenant.id, scopes: ["site:read"] } as Actor), { slug: "x3", name: "X", price: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("結帳：server 依 DB 重新計價", () => {
  it("前端竄改價格／總價的欄位一律無效（表單直接打 checkout 路由）", async () => {
    const store = newStore();
    const { tenant, mug } = await makeShop(store, "price-shop");
    const form = new URLSearchParams({
      items: JSON.stringify([{ productId: mug.id, qty: 2, price: 1, unitPrice: 1, lineTotal: 2 }]),
      total: "1",
      subtotal: "1",
      contactName: contact.name,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      shipSame: "on",
      shipAddress: shipping.address,
      paymentMethod: "offline",
    });
    const res = await handleCheckout(new Request("http://test.local/s/price-shop/api/shop/checkout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }), "price-shop", store);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toMatch(/^\/s\/price-shop\/orders\/PRICES-\d{8}-0001$/);
    const order = (await store.getOrderByNo(tenant.id, decodeURIComponent(loc.pathname.split("/").pop()!)))!;
    expect(order.subtotal).toBe(700);
    expect(order.shipping_fee).toBe(80);
    expect(order.total).toBe(780);
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(3);
  });

  it("規格價格、滿額免運、合併重複品項", async () => {
    const store = newStore();
    const { tenant, tee } = await makeShop(store, "var-shop");
    const L = tee.variants.find((v) => v.options["尺寸"] === "L")!;
    const r = await priceCart(store, tenant.id, [{ productId: tee.id, variantId: L.id, qty: 1 }, { productId: tee.id, variantId: L.id, qty: 1 }], { shippingFee: 80, freeShippingThreshold: 1000 });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.unit_price).toBe(650);
    expect(r.subtotal).toBe(1300);
    expect(r.shippingFee).toBe(0);
    const noVariant = await priceCart(store, tenant.id, [{ productId: tee.id, qty: 1 }], {});
    expect(noVariant.problems[0]).toMatch(/請選擇規格/);
  });

  it("下架商品不能買", async () => {
    const store = newStore();
    const { ctx, tenant, mug } = await makeShop(store, "off-shop");
    await updateProduct(ctx, { site: "off-shop", productId: mug.id, patch: { status: "draft" }, confirm: true });
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 1 }]) })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("庫存", () => {
  it("任一品項不足 → 整筆失敗，其他品項庫存不變、沒有訂單", async () => {
    const store = newStore();
    const { tenant, mug, tee } = await makeShop(store, "stock-shop");
    const M = tee.variants.find((v) => v.options["尺寸"] === "M")!;
    // 繞過 priceCart 的友善檢查，直接測原子下單（等同 SQL 函式）
    const items = [
      { product_id: mug.id, variant_id: null, name: "馬克杯", variant_label: null, sku: null, unit_price: 350, qty: 2, line_total: 700 },
      { product_id: tee.id, variant_id: M.id, name: "T 恤", variant_label: "M", sku: null, unit_price: 600, qty: 3, line_total: 1800 },
    ];
    const order = { order_prefix: "ST", member_id: null, contact, shipping, subtotal: 2500, shipping_fee: 0, total: 2500, payment_method: "offline" as const, expires_at: new Date(Date.now() + 3600e3).toISOString(), access_key_hash: "x", note: null };
    await expect(store.placeOrder(tenant.id, order, items, "20261018")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
    expect((await store.listVariants(tenant.id, [tee.id])).find((v) => v.id === M.id)!.stock).toBe(2);
    expect((await store.listOrders(tenant.id, { limit: 10, offset: 0 })).total).toBe(0);
    // 經過服務層：清楚的錯誤訊息
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: tee.id, variantId: M.id, qty: 3 }]) })).rejects.toThrow(/庫存不足/);
  });

  it("取消回補庫存且冪等（重複取消／重複回補不會多補）", async () => {
    const store = newStore();
    const { ctx, tenant, mug } = await makeShop(store, "restock-shop");
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 3 }]) });
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(2);
    await expect(cancelOrder(ctx, { site: "restock-shop", orderNo: order.order_no })).rejects.toMatchObject({ code: "confirm_required" });
    const c = await cancelOrder(ctx, { site: "restock-shop", orderNo: order.order_no, confirm: true });
    expect(c.stockReleased).toBe(true);
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
    await expect(cancelOrder(ctx, { site: "restock-shop", orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "conflict" });
    expect(await store.releaseOrderStock(tenant.id, order.id)).toBe(false);
    expect((await store.cancelOrder(tenant.id, order.id, ["pending_payment", "paid"], "again")).transitioned).toBe(false);
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
  });

  it("逾期未付：讀取時 lazy 取消並回補（只做一次）", async () => {
    const store = newStore();
    const { ctx, tenant, mug } = await makeShop(store, "expire-shop", { orderExpireHours: 1 });
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 2 }]) });
    const later = Date.now() + 2 * 3600e3;
    const a = await expireIfDue(store, order, later);
    expect(a.status).toBe("cancelled");
    expect(a.cancel_reason).toBe("expired");
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
    await expireIfDue(store, order, later);
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
    expect((await getOrder(ctx, { site: "expire-shop", orderNo: order.order_no })).status).toBe("cancelled");
  });
});

describe("訂單狀態機", () => {
  it("轉換表：只允許 待付款→已付款/取消、已付款→出貨/取消", () => {
    expect(canTransition("pending_payment", "paid")).toBe(true);
    expect(canTransition("pending_payment", "fulfilled")).toBe(false);
    expect(canTransition("paid", "pending_payment")).toBe(false);
    expect(canTransition("fulfilled", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "paid")).toBe(false);
    expect(ORDER_TRANSITIONS.fulfilled).toEqual([]);
  });

  it("非法轉換被拒；線下匯款 標記收款 → 出貨；寄信給客人與店主", async () => {
    const store = newStore();
    const { ctx, tenant, mug } = await makeShop(store, "flow-shop");
    const m = mailer();
    const c = { ...ctx, sendMail: m.sendMail };
    const { order } = await placeOrder({ store, baseUrl: "http://t", sendMail: m.sendMail }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 1 }]) });
    expect(m.sent.map((x) => x.to)).toEqual(["buyer@example.com", "owner@example.com"]);
    await expect(fulfillOrder(c, { site: "flow-shop", orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "conflict" });
    await expect(markOrderPaid(c, { site: "flow-shop", orderNo: order.order_no })).rejects.toMatchObject({ code: "confirm_required" });
    const paid = await markOrderPaid(c, { site: "flow-shop", orderNo: order.order_no, confirm: true });
    expect(paid.status).toBe("paid");
    await expect(markOrderPaid(c, { site: "flow-shop", orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "conflict" });
    const f = await fulfillOrder(c, { site: "flow-shop", orderNo: order.order_no, confirm: true, trackingNumber: "TW123" });
    expect(f.status).toBe("fulfilled");
    await expect(cancelOrder(c, { site: "flow-shop", orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "conflict" });
    expect(m.sent.filter((x) => /付款成功|已付款/.test(x.subject))).toHaveLength(2);
  });

  it("已付款訂單取消：回補庫存並清楚提示需人工退款", async () => {
    const store = newStore();
    const { ctx, tenant, mug } = await makeShop(store, "refund-shop");
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 1 }]) });
    await markOrderPaid(ctx, { site: "refund-shop", orderNo: order.order_no, confirm: true });
    await expect(cancelOrder(ctx, { site: "refund-shop", orderNo: order.order_no })).rejects.toThrow(/不會自動退款/);
    const r = await cancelOrder(ctx, { site: "refund-shop", orderNo: order.order_no, confirm: true });
    expect(r.refundRequired).toBe(true);
    expect(r.note).toMatch(/退款/);
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
  });

  it("PChomePay 訂單不能手動標記已收款；orders:read 不能改狀態", async () => {
    const store = newStore();
    const { tenant, mug } = await makeShop(store, "nomark-shop");
    await savePaymentAccount(ctxFor(store), { site: "nomark-shop", appId: "APPID123", secret: "secret-value-123", sandbox: false });
    await store.markPaymentAccount(tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 1 }], { paymentMethod: "pchomepay" }) });
    await expect(markOrderPaid(ctxFor(store), { site: "nomark-shop", orderNo: order.order_no, confirm: true })).rejects.toThrow(/不能手動標記/);
    const reader = ctxFor(store, { kind: "token", label: "t", tenantId: tenant.id, scopes: ["orders:read"] } as Actor);
    await expect(cancelOrder(reader, { orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("付款方式與金流設定", () => {
  it("沒有已驗證憑證 → shop 為 pending_setup、不能選 PChomePay；驗證後 enabled", async () => {
    const store = newStore();
    const { tenant, mug } = await makeShop(store, "setup-shop");
    expect((await store.listTenantModules(tenant.id)).find((m) => m.module_id === "shop")!.status).toBe("pending_setup");
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: mug.id, qty: 1 }], { paymentMethod: "pchomepay" }) })).rejects.toThrow(/無法使用線上付款/);

    // MCP（token actor）不能設定憑證
    const tok = ctxFor(store, { kind: "token", label: "t", tenantId: tenant.id, scopes: ["orders:write", "orders:read", "commerce:write", "modules:write"] } as Actor);
    await expect(savePaymentAccount(tok, { site: "setup-shop", appId: "APPID123", secret: "secret-value-123", sandbox: true })).rejects.toMatchObject({ code: "forbidden" });

    const admin = ctxFor(store);
    await savePaymentAccount(admin, { site: "setup-shop", appId: "APPID123", secret: "secret-value-123", sandbox: true });
    const fake = async () => ({ client: { verify: async () => ({ ok: true as const }) } as unknown as PchomepayClient, sandbox: true });
    await verifyPaymentAccount(admin, { site: "setup-shop" }, fake);
    expect((await store.listTenantModules(tenant.id)).find((m) => m.module_id === "shop")!.status).toBe("enabled");
    const st = await getPaymentSetupStatus(tok, {});
    expect(st.pchomepay).toMatchObject({ configured: true, status: "verified", sandbox: true });
    expect(JSON.stringify(st)).not.toContain("secret-value-123");
    expect(JSON.stringify(st)).not.toContain("APPID123");
  });

  it("線上付款低於 NT$30 被擋；PChomePay 結帳 303 到 payment_url 並寫入 gateway_order_no", async () => {
    const store = newStore();
    const { ctx, tenant } = await makeShop(store, "pc-shop", { shippingFee: 0 });
    const cheap = await createProduct(ctx, { site: "pc-shop", slug: "sticker", name: "貼紙", price: 20, status: "published", confirm: true });
    await savePaymentAccount(ctx, { site: "pc-shop", appId: "APPID123", secret: "secret-value-123", sandbox: false });
    await store.markPaymentAccount(tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: orderInput([{ productId: cheap.id, qty: 1 }], { paymentMethod: "pchomepay" }) })).rejects.toThrow(/最低金額為 NT\$30/);

    let created: Record<string, unknown> | null = null;
    const factory = async () => ({
      sandbox: false,
      client: {
        createPayment: async (i: Record<string, unknown>) => {
          created = i;
          return { paymentUrl: "https://sandbox-secure.pchomepay.com.tw/pay/xyz" };
        },
      } as unknown as PchomepayClient,
    });
    const form = new URLSearchParams({ items: JSON.stringify([{ productId: cheap.id, qty: 2 }]), contactName: "A", contactEmail: "a@example.com", contactPhone: "0912000000", shipSame: "on", shipAddress: "addr", paymentMethod: "pchomepay" });
    const res = await handleCheckout(new Request("http://test.local/s/pc-shop/api/shop/checkout", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } }), "pc-shop", store, factory);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://sandbox-secure.pchomepay.com.tw/pay/xyz");
    expect(created!.amount).toBe(40);
    expect(String(created!.notifyUrl)).toBe(`http://test.local/api/pay/pchomepay/notify/${tenant.id}`);
    const orders = (await store.listOrders(tenant.id, { limit: 5, offset: 0 })).rows;
    const pays = await store.listPaymentsForOrder(tenant.id, orders[0]!.id);
    expect(pays[0]!.gateway_order_no).toMatch(/^GB[A-Z0-9]{8,18}$/);
    expect(pays[0]!.gateway_order_no.length).toBeLessThanOrEqual(20);
    expect(pays[0]!.amount).toBe(40);
  });

  it("金流建單失敗：訂單取消並回補庫存，導回結帳頁帶錯誤", async () => {
    const store = newStore();
    const { tenant, mug } = await makeShop(store, "fail-shop");
    await savePaymentAccount(ctxFor(store), { site: "fail-shop", appId: "APPID123", secret: "secret-value-123", sandbox: false });
    await store.markPaymentAccount(tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const factory = async () => ({ sandbox: false, client: { createPayment: async () => null } as unknown as PchomepayClient });
    const form = new URLSearchParams({ items: JSON.stringify([{ productId: mug.id, qty: 1 }]), contactName: "A", contactEmail: "a@example.com", contactPhone: "0912000000", shipSame: "on", shipAddress: "addr", paymentMethod: "pchomepay" });
    const res = await handleCheckout(new Request("http://test.local/s/fail-shop/api/shop/checkout", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } }), "fail-shop", store, factory);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/s/fail-shop/checkout");
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(5);
    expect((await store.listOrders(tenant.id, { limit: 5, offset: 0 })).rows[0]!.status).toBe("cancelled");
  });
});

export type { TenantRow };
