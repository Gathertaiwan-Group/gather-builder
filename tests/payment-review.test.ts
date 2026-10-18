/**
 * 第二輪獨立金流審查（2026-10-18）的修正：H1 sandbox、H2 逾期前回查、H3 查單欄位、M1 庫存 DoS、M2 規格庫存、L1、L4。
 * 查單回應一律用真實結構（status="S"／"F"／"P"，成功時 status_code=null），依據見 lib/pay/pchomepay.ts。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { createProduct, paymentAvailability, placeOrder, updateProduct, DEFAULT_ONLINE_HOLD_MINUTES } from "@/lib/services/shop";
import { QUERY_FAILURE_ALERT_AT, expireIfDue, fulfillOrder, handlePchomepayNotify, savePaymentAccount, startPchomepayPayment, type PayDeps } from "@/lib/services/orders";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { CHECKOUT_LIMIT_PER_HOUR, handleCheckout } from "@/lib/shop-routes";
import { createPreviewToken } from "@/lib/preview";
import { classifyPchomepayQuery, type PchomepayClient, type PchomepayQuery } from "@/lib/pay/pchomepay";
import { decryptSecret, encryptSecret } from "@/lib/secretbox";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 5).toString("base64");
});

const contact = { name: "客人", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "客人", phone: "0912345678", address: "台中市" };

const q = (data: Record<string, unknown>): PchomepayQuery => ({
  status: data.status != null ? String(data.status) : undefined,
  status_code: data.status_code != null ? String(data.status_code) : undefined,
  amount: data.amount != null ? Number(data.amount) : undefined,
  raw: data,
});

async function verifiedShop(store: Store, slug: string, sandbox: boolean, settings: Record<string, unknown> = {}) {
  const shop = await makeShop(store, slug, settings);
  await savePaymentAccount(ctxFor(store), { site: slug, appId: "APPID123", secret: "secret-value-123", sandbox });
  await store.markPaymentAccount(shop.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  return shop;
}

async function onlineOrder(store: Store, shop: Awaited<ReturnType<typeof verifiedShop>>, sandbox: boolean) {
  const { order, accessKey } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay" }, allowSandbox: sandbox });
  const factory = async () => ({ sandbox, client: { createPayment: async () => ({ paymentUrl: "https://example.invalid/pay" }) } as unknown as PchomepayClient });
  const pay = await startPchomepayPayment({ store, baseUrl: "http://t", clientFactory: factory }, { tenant: shop.tenant, order, accessKey });
  return { order, gw: pay.gatewayOrderNo };
}

function payDeps(store: Store, query: () => Promise<PchomepayQuery | null>) {
  const sent: { to: string; subject: string }[] = [];
  const d: PayDeps = { store, baseUrl: "http://t", sendMail: async (to, subject) => void sent.push({ to, subject }), queryFor: async () => ({ queryPayment: query }) };
  return { d, sent };
}

const notifyBody = (gw: string) => new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: gw, status: "S" }) }).toString();
const checkoutForm = (productId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ items: JSON.stringify([{ productId, qty: 1 }]), contactName: "A", contactEmail: "a@example.com", contactPhone: "0912000000", shipSame: "on", shipAddress: "addr", paymentMethod: "pchomepay", ...extra });
const req = (slug: string, form: URLSearchParams) => new Request(`http://test.local/s/${slug}/api/shop/checkout`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("H1：sandbox 憑證不能當成真付款", () => {
  it("已發布網站：sandbox 憑證不提供線上付款；只有帶有效預覽簽章才可用", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h1-avail", true);
    const settings = {};
    expect((await paymentAvailability(store, shop.tenant, settings)).pchomepay).toBe(false);
    expect((await paymentAvailability(store, shop.tenant, settings, { allowSandbox: true })).pchomepay).toBe(true);
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay" } })).rejects.toThrow(/無法使用線上付款/);

    const factory = async () => ({ sandbox: true, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/pay/t" }) } as unknown as PchomepayClient });
    const noPreview = await handleCheckout(req("h1-avail", checkoutForm(shop.mug.id)), "h1-avail", store, factory);
    expect(new URL(noPreview.headers.get("location")!).pathname).toBe("/s/h1-avail/checkout");
    const forged = await handleCheckout(req("h1-avail", checkoutForm(shop.mug.id, { preview: "forged.token" })), "h1-avail", store, factory);
    expect(new URL(forged.headers.get("location")!).pathname).toBe("/s/h1-avail/checkout");
    const other = await handleCheckout(req("h1-avail", checkoutForm(shop.mug.id, { preview: createPreviewToken("another-tenant", process.env.PREVIEW_SECRET!) })), "h1-avail", store, factory);
    expect(new URL(other.headers.get("location")!).pathname).toBe("/s/h1-avail/checkout");
    const ok = await handleCheckout(req("h1-avail", checkoutForm(shop.mug.id, { preview: createPreviewToken(shop.tenant.id, process.env.PREVIEW_SECRET!) })), "h1-avail", store, factory);
    expect(ok.headers.get("location")).toBe("https://sandbox-secure.pchomepay.com.tw/pay/t");
  });

  it("sandbox 付款成功 → 訂單標記 payment_sandbox、店主信寫「請勿出貨」、fulfill_order 被拒", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h1-paid", true);
    const { order, gw } = await onlineOrder(store, shop, true);
    const { d, sent } = payDeps(store, async () => q({ order_id: gw, status: "S", status_code: null, amount: order.total }));
    expect((await handlePchomepayNotify(d, { tenantId: shop.tenant.id, rawBody: notifyBody(gw) })).outcome).toBe("paid");
    const after = (await store.getOrderById(shop.tenant.id, order.id))!;
    expect(after.status).toBe("paid");
    expect(after.payment_sandbox).toBe(true);
    expect(sent.find((m) => m.to === "owner@example.com")!.subject).toMatch(/請勿出貨/);
    expect(sent.some((m) => /請安排出貨/.test(m.subject))).toBe(false);
    await expect(fulfillOrder(shop.ctx, { site: "h1-paid", orderId: order.id, confirm: true })).rejects.toMatchObject({ code: "invalid" });
  });

  it("正式憑證的付款成功照常可以出貨", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h1-live", false);
    const { order, gw } = await onlineOrder(store, shop, false);
    const { d } = payDeps(store, async () => q({ order_id: gw, status: "S", status_code: null, amount: order.total }));
    await handlePchomepayNotify(d, { tenantId: shop.tenant.id, rawBody: notifyBody(gw) });
    expect((await store.getOrderById(shop.tenant.id, order.id))!.payment_sandbox).toBe(false);
    await expect(fulfillOrder(shop.ctx, { site: "h1-live", orderId: order.id, confirm: true })).resolves.toMatchObject({ status: "fulfilled" });
  });
});

describe("H2：逾期取消前先權威回查", () => {
  const later = () => Date.now() + 10 * 24 * 3600_000;

  it("回查已付 → 走付款流程（不取消）", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h2-paid", false);
    const { order, gw } = await onlineOrder(store, shop, false);
    const { d, sent } = payDeps(store, async () => q({ order_id: gw, status: "S", status_code: null, amount: order.total }));
    const after = await expireIfDue(store, (await store.getOrderById(shop.tenant.id, order.id))!, later(), d);
    expect(after.status).toBe("paid");
    expect(sent.some((m) => /付款成功/.test(m.subject))).toBe(true);
  });

  it("回查失敗 → 不取消；連續失敗達門檻警示店主（只寄一次）", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h2-fail", false);
    const { order } = await onlineOrder(store, shop, false);
    const { d, sent } = payDeps(store, async () => null);
    for (let i = 0; i < QUERY_FAILURE_ALERT_AT + 2; i++) {
      const o = await expireIfDue(store, (await store.getOrderById(shop.tenant.id, order.id))!, later(), d);
      expect(o.status).toBe("pending_payment");
    }
    expect(sent.filter((m) => m.to === "owner@example.com" && /無法確認/.test(m.subject))).toHaveLength(1);
    expect((await store.listPaymentsForOrder(shop.tenant.id, order.id))[0]!.query_failures).toBe(QUERY_FAILURE_ALERT_AT + 2);
  });

  it("回查為處理中（P／WP）或失敗（F）→ 可以取消並回補庫存", async () => {
    for (const [slug, resp] of [["h2-p", { status: "P", status_code: "WP" }], ["h2-f", { status: "F", status_code: "FE" }]] as const) {
      const store = newStore();
      const shop = await verifiedShop(store, slug, false);
      const { order, gw } = await onlineOrder(store, shop, false);
      const { d } = payDeps(store, async () => q({ order_id: gw, ...resp, amount: order.total }));
      const after = await expireIfDue(store, (await store.getOrderById(shop.tenant.id, order.id))!, later(), d);
      expect(after.status).toBe("cancelled");
      expect((await store.getProductById(shop.tenant.id, shop.mug.id))!.stock).toBe(5);
    }
  });

  it("無法辨識的狀態 → 不取消、警示店主", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h2-unknown", false);
    const { order, gw } = await onlineOrder(store, shop, false);
    const { d, sent } = payDeps(store, async () => q({ order_id: gw, status: "X", amount: order.total }));
    const after = await expireIfDue(store, (await store.getOrderById(shop.tenant.id, order.id))!, later(), d);
    expect(after.status).toBe("pending_payment");
    expect(sent.some((m) => /無法確認/.test(m.subject))).toBe(true);
  });
});

describe("H3：查單回應判讀（status 為權威欄位）", () => {
  it("classifyPchomepayQuery", () => {
    expect(classifyPchomepayQuery({ status: "S" })).toBe("paid"); // 實測：成功時 status_code=null
    expect(classifyPchomepayQuery({ status: "S", status_code: "FE" })).toBe("unknown");
    expect(classifyPchomepayQuery({ status: "F", status_code: "FB" })).toBe("failed");
    expect(classifyPchomepayQuery({ status: "P", status_code: "WP" })).toBe("pending");
    expect(classifyPchomepayQuery({ status_code: "WAP" })).toBe("pending");
    expect(classifyPchomepayQuery({ status_code: "FX" })).toBe("failed");
    // 舊版誤判：只看 status_code="S"／"00"／"1" 當成功 —— 現在不認
    expect(classifyPchomepayQuery({ status_code: "S" })).toBe("unknown");
    expect(classifyPchomepayQuery({ status_code: "00" })).toBe("unknown");
    expect(classifyPchomepayQuery({})).toBe("unknown");
  });

  it("notify：無法辨識 → 500 重試＋警示；失敗 F → 付款標 failed、回 success", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "h3-notify", false);
    const { order, gw } = await onlineOrder(store, shop, false);
    const u = payDeps(store, async () => q({ order_id: gw, status: "?", amount: order.total }));
    expect(await handlePchomepayNotify(u.d, { tenantId: shop.tenant.id, rawBody: notifyBody(gw) })).toMatchObject({ status: 500, body: "retry" });
    expect(u.sent.some((m) => /無法確認/.test(m.subject))).toBe(true);
    expect((await store.getOrderById(shop.tenant.id, order.id))!.status).toBe("pending_payment");
    const f = payDeps(store, async () => q({ order_id: gw, status: "F", status_code: "FA", amount: order.total }));
    expect(await handlePchomepayNotify(f.d, { tenantId: shop.tenant.id, rawBody: notifyBody(gw) })).toMatchObject({ status: 200, outcome: "failed:FA" });
    expect((await store.getPaymentByGatewayNo(gw))!.status).toBe("failed");
  });
});

describe("L1：回查必須用建單時的環境", () => {
  it("付款是正式環境建的，憑證被換成 sandbox → 不回查、回 500", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "l1-env", false);
    const { gw } = await onlineOrder(store, shop, false);
    await savePaymentAccount(ctxFor(store), { site: "l1-env", appId: "APPID999", secret: "secret-value-999", sandbox: true });
    // 不給 queryFor → 走預設（讀 DB 憑證）；環境不符時連 client 都不建，不會打任何網路
    const r = await handlePchomepayNotify({ store, baseUrl: "http://t" }, { tenantId: shop.tenant.id, rawBody: notifyBody(gw) });
    expect(r).toMatchObject({ status: 500, outcome: "query_failed" });
    expect((await store.getPaymentByGatewayNo(gw))!.last_query_error).toMatch(/環境/);
  });
});

describe("M1：庫存 DoS", () => {
  it("線上刷卡訂單保留時間短（預設 60 分鐘）；ATM 需店家開啟且保留 orderExpireHours", async () => {
    const store = newStore();
    const shop = await verifiedShop(store, "m1-hold", false);
    const t0 = Date.now();
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay" } });
    const holdMin = (new Date(order.expires_at!).getTime() - t0) / 60_000;
    expect(holdMin).toBeGreaterThan(DEFAULT_ONLINE_HOLD_MINUTES - 1);
    expect(holdMin).toBeLessThan(DEFAULT_ONLINE_HOLD_MINUTES + 1);
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay", pchomepayType: "atm" } })).rejects.toThrow(/ATM/);

    await configureModule(shop.ctx, { site: "m1-hold", moduleId: "shop", config: { pchomepayAtm: true, orderExpireHours: 72 } });
    await publishSite(shop.ctx, { site: "m1-hold", confirm: true });
    const fresh = (await store.getTenantBySlug("m1-hold"))!; // 發布後 published_revision_id 已變
    const atm = await placeOrder({ store, baseUrl: "http://t" }, { tenant: fresh, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay", pchomepayType: "atm" } });
    expect(Math.round((new Date(atm.order.expires_at!).getTime() - Date.now()) / 3600_000)).toBe(72);
  });

  it("每品項數量上限（預設 10，可設定）；每 IP 每小時下單上限降為 6", async () => {
    const store = newStore();
    const { ctx, tenant } = await makeShop(store, "m1-qty");
    const p = await createProduct(ctx, { site: "m1-qty", slug: "many", name: "很多", price: 10, status: "published", confirm: true });
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: p.id, qty: 11 }], contact, shipping, paymentMethod: "offline" } })).rejects.toThrow(/最多 10 件/);
    await configureModule(ctx, { site: "m1-qty", moduleId: "shop", config: { maxQtyPerItem: 3 } });
    await publishSite(ctx, { site: "m1-qty", confirm: true });
    const fresh = (await store.getTenantBySlug("m1-qty"))!;
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: fresh, member: null, data: { items: [{ productId: p.id, qty: 4 }], contact, shipping, paymentMethod: "offline" } })).rejects.toThrow(/最多 3 件/);
    expect(CHECKOUT_LIMIT_PER_HOUR).toBe(6);
  });

  it("下單前先釋放該商品已逾期的保留", async () => {
    const store = newStore();
    const { tenant, mug } = await makeShop(store, "m1-release");
    // 一張逾期未付、佔走全部 5 件庫存的線下匯款訂單
    const { id } = await store.placeOrder(
      tenant.id,
      { order_prefix: "RL", member_id: null, contact, shipping, subtotal: 1750, shipping_fee: 0, total: 1750, payment_method: "offline", expires_at: new Date(Date.now() - 60_000).toISOString(), access_key_hash: "x", note: null },
      [{ product_id: mug.id, variant_id: null, name: "馬克杯", variant_label: null, sku: null, unit_price: 350, qty: 5, line_total: 1750 }],
      "20261018",
    );
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(0);
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    expect(order.status).toBe("pending_payment");
    expect((await store.getOrderById(tenant.id, id))!.status).toBe("cancelled");
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(4);
  });
});

describe("M2：規格庫存 patch 語意", () => {
  it("沒帶 stock 不動庫存；改既有規格庫存要帶 expectedStock，不符 conflict", async () => {
    const store = newStore();
    const { ctx, tenant, tee } = await makeShop(store, "m2-variants");
    const r = await updateProduct(ctx, { site: "m2-variants", productId: tee.id, confirm: true, patch: { variants: [{ options: { 尺寸: "M" }, price: 700 }, { options: { 尺寸: "L" } }] } });
    expect(r.variants.map((v) => v.stock)).toEqual([2, 1]);
    await expect(updateProduct(ctx, { site: "m2-variants", productId: tee.id, confirm: true, patch: { variants: [{ options: { 尺寸: "M" }, stock: 9 }, { options: { 尺寸: "L" } }] } })).rejects.toMatchObject({ code: "invalid" });
    await expect(updateProduct(ctx, { site: "m2-variants", productId: tee.id, confirm: true, patch: { variants: [{ options: { 尺寸: "M" }, stock: 9, expectedStock: 5 }, { options: { 尺寸: "L" } }] } })).rejects.toMatchObject({ code: "conflict" });
    const ok = await updateProduct(ctx, { site: "m2-variants", productId: tee.id, confirm: true, patch: { variants: [{ options: { 尺寸: "M" }, stock: 9, expectedStock: 2 }, { options: { 尺寸: "L" } }, { options: { 尺寸: "XL" } }] } });
    expect(ok.variants.map((v) => [v.options["尺寸"], v.stock])).toEqual([["M", 9], ["L", 1], ["XL", 0]]);
    expect((await store.listVariants(tenant.id, [tee.id])).length).toBe(3);
  });
});

describe("L4：secretbox 拒絕被截短的 tag", () => {
  it("tag 不是 16 bytes → 解密失敗", () => {
    const enc = encryptSecret("hello", "tenant-x");
    const parts = enc.split(".");
    const short = Buffer.from(parts[3]!, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptSecret([parts[0], parts[1], parts[2], short, parts[4]].join("."), "tenant-x")).toThrow(/長度/);
    expect(decryptSecret(enc, "tenant-x")).toBe("hello");
  });
});
