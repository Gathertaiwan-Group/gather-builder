/**
 * 整合測試（npm run test:db）：members／shop 的 Supabase 實作與 SQL 函式
 * builder_place_order／builder_cancel_order／builder_release_order_stock。
 * 建 is_test 租戶，跑完整個刪除（cascade）並清掉限流列。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder, updateProduct } from "@/lib/services/shop";
import { cancelOrder, fulfillOrder, handlePchomepayNotify, markOrderPaid, savePaymentAccount, startPchomepayPayment } from "@/lib/services/orders";
import { getSessionMember, loginMember, registerMember, resetPassword, sha256 } from "@/lib/services/members";
import { decryptSecret } from "@/lib/secretbox";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";
import type { PchomepayClient } from "@/lib/pay/pchomepay";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slugA = `itshop-a-${ts}`;
const slugB = `itshop-b-${ts}`;

const contact = { name: "整合測試", email: "itest@example.com", phone: "0912345678" };
const shipping = { name: "整合測試", phone: "0912345678", address: "測試地址" };

describe.skipIf(!enabled)("members／shop Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };
  const deps = { store, ipSecret: `itest-ip-${ts}`, baseUrl: "http://itest" };

  afterAll(async () => {
    if (!enabled) return;
    const db = createServiceClient();
    for (const s of [slugA, slugB]) {
      const t = await db.from("builder_tenants").select("id").eq("slug", s).maybeSingle();
      if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
      await db.from("builder_tenants").delete().eq("slug", s);
    }
    const left = await db.from("builder_tenants").select("id").in("slug", [slugA, slugB]);
    expect(left.data).toEqual([]);
  });

  it("建立兩個測試商店", async () => {
    for (const slug of [slugA, slugB]) {
      await createSite(ctx, { slug, name: slug, modules: ["shop"], test: true });
      await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, shippingFee: 0, orderPrefix: "IT" } });
      await publishSite(ctx, { site: slug, confirm: true });
    }
  });

  it("會員：(tenant,email) 隔離、session 綁租戶、重設 token 一次性（含併發）", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const b = (await store.getTenantBySlug(slugB))!;
    await registerMember(deps, { tenant: a, ip: "1.1.1.1", data: { email: "Same@Example.com", password: "password-aaa" } });
    await registerMember(deps, { tenant: b, ip: "1.1.1.1", data: { email: "same@example.com", password: "password-bbb" } });
    expect((await store.getMemberByEmail(a.id, "same@example.com"))!.id).not.toBe((await store.getMemberByEmail(b.id, "same@example.com"))!.id);
    // 同租戶重複 email 被 unique 擋（insertMember 回 null）
    expect(await store.insertMember({ tenant_id: a.id, email: "same@example.com", password_hash: "x", name: null, phone: null })).toBeNull();

    const s = await loginMember(deps, { tenant: a, ip: "1.1.1.1", email: "same@example.com", password: "password-aaa" });
    expect(await getSessionMember(store, a, s.token)).not.toBeNull();
    expect(await getSessionMember(store, b, s.token)).toBeNull();

    const m = (await store.getMemberByEmail(a.id, "same@example.com"))!;
    const raw = `itest-reset-${ts}-xxxxxxxxxxxxxxxx`;
    await store.insertMemberToken({ tenant_id: a.id, member_id: m.id, purpose: "reset_password", token_hash: sha256(raw), expires_at: new Date(Date.now() + 60_000).toISOString() });
    const now = new Date().toISOString();
    const both = await Promise.all([store.consumeMemberToken(a.id, sha256(raw), "reset_password", now), store.consumeMemberToken(a.id, sha256(raw), "reset_password", now)]);
    expect(both.filter(Boolean)).toHaveLength(1);

    const raw2 = `itest-reset2-${ts}-xxxxxxxxxxxxxxx`;
    await store.insertMemberToken({ tenant_id: a.id, member_id: m.id, purpose: "reset_password", token_hash: sha256(raw2), expires_at: new Date(Date.now() + 60_000).toISOString() });
    const r = await resetPassword(deps, { tenant: a, ip: "1.1.1.1", token: raw2, password: "password-new" });
    expect(r.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(await getSessionMember(store, a, s.token)).toBeNull();
  });

  it("併發搶最後一件：只成功一筆，庫存不會變負數", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const p = await createProduct(ctx, { site: slugA, slug: "last-one", name: "最後一件", price: 500, trackInventory: true, stock: 1, status: "published", confirm: true });
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => placeOrder({ store, baseUrl: "http://itest" }, { tenant: a, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } })),
    );
    const ok = attempts.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const f of attempts.filter((x) => x.status === "rejected")) expect(String((f as PromiseRejectedResult).reason.message)).toMatch(/庫存不足/);
    expect((await store.getProductById(a.id, p.id))!.stock).toBe(0);
    const order = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof placeOrder>>>).value.order;
    expect(order.order_no).toMatch(/^IT-\d{8}-\d{4}$/);
    const items = await store.listOrderItems(a.id, order.id);
    expect(items[0]!.stock_deducted).toBe(true);
  });

  it("任一品項不足整單失敗（SQL 函式回滾前面已扣的庫存）", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const p1 = await createProduct(ctx, { site: slugA, slug: "plenty", name: "很多", price: 100, trackInventory: true, stock: 10, status: "published", confirm: true });
    const p2 = await createProduct(ctx, { site: slugA, slug: "scarce", name: "很少", price: 100, trackInventory: true, stock: 1, status: "published", confirm: true });
    const items = [
      { product_id: p1.id, variant_id: null, name: "很多", variant_label: null, sku: null, unit_price: 100, qty: 3, line_total: 300 },
      { product_id: p2.id, variant_id: null, name: "很少", variant_label: null, sku: null, unit_price: 100, qty: 2, line_total: 200 },
    ];
    const order = { order_prefix: "IT", member_id: null, contact, shipping, subtotal: 500, shipping_fee: 0, total: 500, payment_method: "offline" as const, expires_at: new Date(Date.now() + 3600e3).toISOString(), access_key_hash: "x", note: null };
    await expect(store.placeOrder(a.id, order, items, "20991231")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.getProductById(a.id, p1.id))!.stock).toBe(10);
    expect((await store.getProductById(a.id, p2.id))!.stock).toBe(1);
  });

  it("取消回補冪等：併發取消只成功一次、庫存只補一次", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const p = await createProduct(ctx, { site: slugA, slug: "restock", name: "回補", price: 200, trackInventory: true, stock: 5, status: "published", confirm: true });
    const { order } = await placeOrder({ store, baseUrl: "http://itest" }, { tenant: a, member: null, data: { items: [{ productId: p.id, qty: 3 }], contact, shipping, paymentMethod: "offline" } });
    expect((await store.getProductById(a.id, p.id))!.stock).toBe(2);
    const rs = await Promise.all(Array.from({ length: 4 }, () => store.cancelOrder(a.id, order.id, ["pending_payment"], "itest")));
    expect(rs.filter((r) => r.transitioned)).toHaveLength(1);
    expect(await store.releaseOrderStock(a.id, order.id)).toBe(false);
    expect((await store.getProductById(a.id, p.id))!.stock).toBe(5);
    await expect(markOrderPaid(ctx, { site: slugA, orderId: order.id, confirm: true })).rejects.toMatchObject({ code: "conflict" });
  });

  it("規格分支：原子扣規格庫存、改價沿用規格 id、刪除規格後回補不誤補商品層；流水號 ≥ 10000 不截斷", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const p = await createProduct(ctx, { site: slugA, slug: "tee", name: "T", price: 500, trackInventory: true, stock: 0, status: "published", confirm: true, variants: [{ options: { size: "M" }, stock: 2 }, { options: { size: "L" }, stock: 1 }] });
    const M = p.variants.find((v) => v.options.size === "M")!;
    const L = p.variants.find((v) => v.options.size === "L")!;
    const o1 = await placeOrder({ store, baseUrl: "http://itest" }, { tenant: a, member: null, data: { items: [{ productId: p.id, variantId: M.id, qty: 2 }, { productId: p.id, variantId: L.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    let vs = await store.listVariants(a.id, [p.id]);
    expect(vs.map((v) => v.stock).sort()).toEqual([0, 0]);
    expect((await store.listOrderItems(a.id, o1.order.id)).every((i) => i.deducted_from === "variant")).toBe(true);
    await expect(placeOrder({ store, baseUrl: "http://itest" }, { tenant: a, member: null, data: { items: [{ productId: p.id, variantId: M.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } })).rejects.toThrow(/庫存不足/);
    // 改價（保留 M、刪掉 L）
    const up = await updateProduct(ctx, { site: slugA, productId: p.id, confirm: true, patch: { variants: [{ options: { size: "M" }, price: 450 }] } });
    expect(up.variants[0]!.id).toBe(M.id);
    expect(up.variants[0]!.stock).toBe(0); // 第二輪審查 M2：沒帶 stock 不動庫存
    // 帶錯的 expectedStock → conflict（真 DB 條件更新）
    await expect(updateProduct(ctx, { site: slugA, productId: p.id, confirm: true, patch: { variants: [{ options: { size: "M" }, stock: 7, expectedStock: 3 }] } })).rejects.toMatchObject({ code: "conflict" });
    expect(await store.setProductStockIf(a.id, p.id, 99, 5)).toBe(false);
    await cancelOrder(ctx, { site: slugA, orderId: o1.order.id, confirm: true });
    vs = await store.listVariants(a.id, [p.id]);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.stock).toBe(2); // M 補回 2；L 已刪除不補
    expect((await store.getProductById(a.id, p.id))!.stock).toBe(0); // 不誤補到商品層

    const db = createServiceClient();
    await db.from("builder_order_counters").upsert({ tenant_id: a.id, day: "20991230", last: 9999 });
    const mug = await createProduct(ctx, { site: slugA, slug: "counter", name: "C", price: 10, status: "published", confirm: true });
    const big = await store.placeOrder(a.id, { order_prefix: "IT", member_id: null, contact, shipping, subtotal: 10, shipping_fee: 0, total: 10, payment_method: "offline", expires_at: new Date(Date.now() + 3600e3).toISOString(), access_key_hash: "x", note: null }, [{ product_id: mug.id, variant_id: null, name: "C", variant_label: null, sku: null, unit_price: 10, qty: 1, line_total: 10 }], "20991230");
    expect(big.order_no).toBe("IT-20991230-10000");

    // M1：依商品找逾期未付的訂單（下單前釋放保留）
    const stale = await store.placeOrder(a.id, { order_prefix: "IT", member_id: null, contact, shipping, subtotal: 10, shipping_fee: 0, total: 10, payment_method: "offline", expires_at: new Date(Date.now() - 60e3).toISOString(), access_key_hash: "x", note: null }, [{ product_id: mug.id, variant_id: null, name: "C", variant_label: null, sku: null, unit_price: 10, qty: 1, line_total: 10 }], "20991231");
    const due = await store.listExpiredPendingOrdersForProducts(a.id, [mug.id], new Date().toISOString(), 10);
    expect(due.map((o) => o.id)).toEqual([stale.id]);
    expect(due[0]!.payment_sandbox).toBe(false);
  });

  it("金流憑證加密存放（DB 看不到明文）＋ notify 重複只轉換一次", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const secret = `itest-plain-secret-${ts}`;
    await savePaymentAccount(ctx, { site: slugA, appId: "ITESTAPP", secret, sandbox: true });
    const db = createServiceClient();
    const raw = await db.from("builder_payment_accounts").select("*").eq("tenant_id", a.id).single();
    expect(JSON.stringify(raw.data)).not.toContain(secret);
    expect(decryptSecret(raw.data!.secret_enc, a.id)).toBe(secret);

    await store.markPaymentAccount(a.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const p = await createProduct(ctx, { site: slugA, slug: "online", name: "線上", price: 120, status: "published", confirm: true });
    const { order, accessKey } = await placeOrder({ store, baseUrl: "http://itest" }, { tenant: a, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay" }, allowSandbox: true });
    const factory = async () => ({ sandbox: true, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/mock" }) } as unknown as PchomepayClient });
    const pay = await startPchomepayPayment({ store, baseUrl: "http://itest", clientFactory: factory }, { tenant: a, order, accessKey });
    const sent: string[] = [];
    const d = { store, baseUrl: "http://itest", sendMail: async (_t: string, s: string) => void sent.push(s), queryFor: async () => ({ queryPayment: async () => ({ status: "S", amount: 120, raw: { status: "S", status_code: null, amount: 120 } }) }) };
    const body = new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: pay.gatewayOrderNo }) }).toString();
    const rs = await Promise.all(Array.from({ length: 3 }, () => handlePchomepayNotify(d, { tenantId: a.id, rawBody: body })));
    expect(rs.filter((r) => r.outcome === "paid")).toHaveLength(1);
    const paid = (await store.getOrderById(a.id, order.id))!;
    expect(paid.status).toBe("paid");
    // H1：sandbox 付款成功 → 訂單標記 payment_sandbox（真 DB 欄位），不能出貨
    expect(paid.payment_sandbox).toBe(true);
    await expect(fulfillOrder(ctx, { site: slugA, orderId: order.id, confirm: true })).rejects.toMatchObject({ code: "invalid" });
    expect((await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!.status).toBe("paid");
  });

  it("已取消訂單收到付款：不改狀態、付款標 paid_after_cancel", async () => {
    const a = (await store.getTenantBySlug(slugA))!;
    const p = await createProduct(ctx, { site: slugA, slug: "late", name: "遲到", price: 90, status: "published", confirm: true });
    const { order, accessKey } = await placeOrder({ store, baseUrl: "http://itest" }, { tenant: a, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay" }, allowSandbox: true });
    const factory = async () => ({ sandbox: true, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/mock" }) } as unknown as PchomepayClient });
    const pay = await startPchomepayPayment({ store, baseUrl: "http://itest", clientFactory: factory }, { tenant: a, order, accessKey });
    await cancelOrder(ctx, { site: slugA, orderId: order.id, confirm: true });
    const d = { store, baseUrl: "http://itest", queryFor: async () => ({ queryPayment: async () => ({ status: "S", amount: 90, raw: { status: "S", status_code: null, amount: 90 } }) }) };
    const body = new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: pay.gatewayOrderNo }) }).toString();
    expect((await handlePchomepayNotify(d, { tenantId: a.id, rawBody: body })).outcome).toBe("paid_after_cancel");
    expect((await store.getOrderById(a.id, order.id))!.status).toBe("cancelled");
    expect((await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!.status).toBe("paid_after_cancel");
    // H2：回查失敗計數與「只警示一次」在真 DB 上的語意
    const pr = (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!;
    expect(await store.bumpPaymentQueryFailure(a.id, pr.id, "x")).toBe(1);
    expect(await store.bumpPaymentQueryFailure(a.id, pr.id, "y")).toBe(2);
    const flags = await Promise.all([store.markPaymentAlerted(a.id, pr.id), store.markPaymentAlerted(a.id, pr.id)]);
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect((await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!.last_query_error).toBe("y");
  });
});
