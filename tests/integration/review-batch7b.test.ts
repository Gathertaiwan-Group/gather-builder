/**
 * 整合測試（npm run test:db）：第七批審查第二輪（migration 0034）在真 DB 上的行為。
 * - 付款短網址碼唯一、getPaymentByShortCode；付款狀態可轉 refunded（check 放寬）。
 * - builder_mark_order_refunded：只對已出貨、只成功一次（併發 5 次只有 1 次）。
 * - builder_record_subscription_charge 接受 paid_after_end：入帳但不改訂閱狀態、同期只一筆。
 * - builder_quota_take：8 個同時 +5000（上限 20000）只成功 4 個。
 * 建 is_test 租戶，跑完刪除。🔴 不呼叫任何金流 API。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { createSubscriptionPlan } from "@/lib/services/subscriptions";
import { genShortCode } from "@/lib/pay/urls";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itrv7b-${ts}`;

describe.skipIf(!enabled)("第七批審查第二輪（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };
  let tenantId = "";

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建站", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["shop", "subscriptions"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "RB" } });
    await publishSite(ctx, { site: slug, confirm: true });
    tenantId = (await store.getTenantBySlug(slug))!.id;
  });

  it("付款短網址碼：唯一、可查回；付款可轉 refunded；已出貨退款標記只成功一次（併發）", async () => {
    const t = (await store.getTenantById(tenantId))!;
    const p = await createProduct(ctx, { site: slug, slug: "item", name: "商品", price: 500, trackInventory: false, status: "published", confirm: true });
    const { order } = await placeOrder({ store, baseUrl: "https://itest.example" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact: { name: "測", email: `rb-${ts}@example.com`, phone: "0912345678" }, shipping: { name: "測", phone: "0912345678", address: "台中" }, paymentMethod: "offline" } });
    const code = genShortCode();
    const pay = await store.insertPayment({ tenant_id: t.id, order_id: order.id, provider: "newebpay", gateway_order_no: `GBRB${ts}`.toUpperCase().slice(0, 20), amount: order.total, sandbox: true, short_code: code, return_key_enc: "v1.test" });
    expect((await store.getPaymentByShortCode(code))!.id).toBe(pay.id);
    await expect(store.insertPayment({ tenant_id: t.id, order_id: order.id, provider: "newebpay", gateway_order_no: `GBRC${ts}`.toUpperCase().slice(0, 20), amount: order.total, sandbox: true, short_code: code })).rejects.toMatchObject({ code: "conflict" });
    expect(await store.transitionPayment(t.id, pay.id, "pending", "paid", {})).toBe(true);
    expect(await store.transitionPayment(t.id, pay.id, "paid", "refunded", {})).toBe(true);
    // 已付款（未出貨）不能標記
    await store.transitionOrder(t.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    expect(await store.markOrderRefunded(t.id, order.id)).toBeNull();
    await store.transitionOrder(t.id, order.id, "paid", "fulfilled", { fulfilled_at: new Date().toISOString() });
    const r = await Promise.all(Array.from({ length: 5 }, () => store.markOrderRefunded(t.id, order.id)));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect((await store.getOrderById(t.id, order.id))!.refunded_at).toBeTruthy();
  });

  it("訂閱扣款 paid_after_end：入帳但不改狀態、同期只一筆（併發 4 次）", async () => {
    const plan = await createSubscriptionPlan(ctx, { site: slug, name: "月費", amount: 299, interval: "month", trialDays: 0, totalPeriods: 12, entitlement: { kind: "none" }, status: "active", confirm: true });
    const m = (await store.insertMember({ tenant_id: tenantId, email: `sub-${ts}@example.com`, password_hash: "x", name: null, phone: null }))!;
    const code = genShortCode();
    const sub = await store.insertSubscription({ tenant_id: tenantId, plan_id: plan.id, member_id: m.id, provider: "newebpay", sandbox: true, merchant_order_no: `SBRB${ts}`.toUpperCase(), amount: 299, interval: "month", total_periods: 12, short_code: code });
    expect((await store.getSubscriptionByShortCode(code))!.id).toBe(sub.id);
    await store.transitionSubscription(tenantId, sub.id, ["pending"], "cancelled", { cancelled_at: new Date().toISOString() });
    const now = new Date().toISOString();
    const r = await Promise.all(Array.from({ length: 4 }, () => store.recordSubscriptionCharge(tenantId, { subscriptionId: sub.id, periodIndex: 2, amount: 299, status: "paid_after_end", tradeNo: null, raw: null, periodEnd: now, graceUntil: now })));
    expect(r.filter((x) => x.inserted)).toHaveLength(1);
    expect(r.every((x) => x.status === "cancelled")).toBe(true);
    expect((await store.listSubscriptionCharges(tenantId, sub.id)).map((c) => c.status)).toEqual(["paid_after_end"]);
  });

  it("builder_quota_take：8 個同時 +5000（上限 20000）只成功 4 個；超過單次上限一律拒絕", async () => {
    const bucket = `adjust-quota:points:${tenantId}`;
    const win = new Date(Date.parse("2026-10-19T00:00:00+08:00")).toISOString();
    const r = await Promise.all(Array.from({ length: 8 }, () => store.quotaTake(bucket, "day", win, 5000, 20000)));
    expect(r.filter((x) => x.allowed)).toHaveLength(4);
    expect(Math.max(...r.map((x) => x.total))).toBe(20000);
    expect((await store.quotaTake(bucket, "day", win, 1, 20000)).allowed).toBe(false);
    expect((await store.quotaTake(`${bucket}:b`, "day", win, 30000, 20000)).allowed).toBe(false);
  });
});
