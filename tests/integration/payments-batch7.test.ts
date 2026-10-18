/**
 * 整合測試（npm run test:db）：第七批金流在真 DB 上的行為。
 * - 新 provider 的訂單／付款／憑證 check 放寬；憑證 secretbox 加密（DB 裡沒有明文）。
 * - 退款只能退一次（partial unique index；併發 5 次只成立 1 筆）；退款紀錄不可刪（42501）。
 * - LINE Pay confirm 宣告（claimPaymentConfirm）併發只有一個拿到。
 * - 訂閱：每期扣款只入帳一次（builder_record_subscription_charge；併發）、扣款紀錄只增不改（42501）、狀態機條件式轉換。
 * 建 is_test 租戶，跑完刪除。🔴 不呼叫任何金流 API。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { saveProviderAccount } from "@/lib/services/orders";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itpay7-${ts}`;

describe.skipIf(!enabled)("第七批金流（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };
  let orderId = "";
  let paymentId = "";

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建站；新 provider 憑證加密存放（DB 沒有明文）；payment_method／provider check 接受新值", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["shop"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "P7" } });
    await publishSite(ctx, { site: slug, confirm: true });
    const t = (await store.getTenantBySlug(slug))!;
    await saveProviderAccount(ctx, { site: slug, provider: "newebpay", appId: "MS127874575", secrets: { hashKey: "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn", hashIv: "C6AcmfqJILwgnhIP" }, sandbox: true });
    const acct = (await db.from("builder_payment_accounts").select("*").eq("tenant_id", t.id).eq("provider", "newebpay").single()).data!;
    expect(acct.secret_enc).toMatch(/^v1\./);
    expect(JSON.stringify(acct)).not.toContain("Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn");
    expect((await store.listPaymentAccounts(t.id)).map((a) => a.provider)).toEqual(["newebpay"]);
    await store.markPaymentAccount(t.id, "newebpay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const p = await createProduct(ctx, { site: slug, slug: "item", name: "商品", price: 500, trackInventory: false, status: "published", confirm: true });
    const { order } = await placeOrder({ store, baseUrl: "https://itest.example" }, { tenant: t, member: null, allowSandbox: true, data: { items: [{ productId: p.id, qty: 1 }], contact: { name: "測", email: `p7-${ts}@example.com`, phone: "0912345678" }, shipping: { name: "測", phone: "0912345678", address: "台中" }, paymentMethod: "newebpay" } });
    expect(order.payment_method).toBe("newebpay");
    orderId = order.id;
    const pay = await store.insertPayment({ tenant_id: t.id, order_id: order.id, provider: "newebpay", gateway_order_no: `GBIT${ts}`.toUpperCase().slice(0, 20), amount: order.total, sandbox: true });
    paymentId = pay.id;
    expect(pay).toMatchObject({ provider: "newebpay", gateway_trade_no: null, confirm_attempts: 0 });
    // 不在清單上的 provider 被 DB 拒絕
    const bad = await db.from("builder_payments").insert({ tenant_id: t.id, order_id: order.id, provider: "jkopay", gateway_order_no: `X${ts}`, amount: 1 });
    expect(bad.error?.code).toBe("23514");
  });

  it("LINE Pay confirm 宣告：併發 6 次只有 1 個拿到；過期才可重新宣告", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const r = await Promise.all(Array.from({ length: 6 }, () => store.claimPaymentConfirm(t.id, paymentId, new Date(Date.now() - 120_000).toISOString())));
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await store.claimPaymentConfirm(t.id, paymentId, new Date(Date.now() + 1000).toISOString())).toBe(true);
  });

  it("退款只能一筆（併發 5 次只成立 1 筆）；failed 後可重新申請；退款紀錄不可刪（42501）", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => store.insertRefund({ tenant_id: t.id, order_id: orderId, payment_id: paymentId, provider: "newebpay", amount: 500, requested_by: "itest", reason: null })));
    const ok = r.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof store.insertRefund>>>[];
    expect(ok).toHaveLength(1);
    expect(await store.transitionRefund(t.id, ok[0]!.value.id, "requested", "failed", { error: "測試" })).toBe(true);
    expect(await store.transitionRefund(t.id, ok[0]!.value.id, "requested", "succeeded", {})).toBe(false);
    const again = await store.insertRefund({ tenant_id: t.id, order_id: orderId, payment_id: paymentId, provider: "newebpay", amount: 500, requested_by: "itest", reason: null });
    expect(again.status).toBe("requested");
    await expect(store.insertRefund({ tenant_id: t.id, order_id: orderId, payment_id: paymentId, provider: "newebpay", amount: 500, requested_by: "itest", reason: null })).rejects.toMatchObject({ code: "conflict" });
    const del = await db.from("builder_refunds").delete().eq("tenant_id", t.id);
    expect(del.error?.code).toBe("42501");
    expect((await store.listRefundsForOrder(t.id, orderId)).length).toBe(2);
  });

  it("訂閱：每期扣款併發 6 次只入帳 1 筆；失敗→past_due、成功→active（SQL 同交易）；扣款紀錄只增不改（42501）；enrollment 接受 subscription 來源", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const m = (await store.insertMember({ tenant_id: t.id, email: `sub-${ts}@example.com`, password_hash: "x", name: "訂閱", phone: null }))!;
    const plan = await store.insertSubscriptionPlan({ tenant_id: t.id, name: "月費", amount: 299, interval: "month", trial_days: 0, total_periods: 12, entitlement: { kind: "none" }, provider: "newebpay", status: "active", description: "" });
    const sub = await store.insertSubscription({ tenant_id: t.id, plan_id: plan.id, member_id: m.id, provider: "newebpay", sandbox: true, merchant_order_no: `SBIT${ts}`.toUpperCase(), amount: 299, interval: "month", total_periods: 12 });
    // 同會員同方案第二筆進行中 → conflict
    await expect(store.insertSubscription({ tenant_id: t.id, plan_id: plan.id, member_id: m.id, provider: "newebpay", sandbox: true, merchant_order_no: `SBIT2${ts}`.toUpperCase(), amount: 299, interval: "month", total_periods: 12 })).rejects.toMatchObject({ code: "conflict" });
    const end = new Date(Date.now() + 32 * 86400_000).toISOString();
    const grace = new Date(Date.now() + 7 * 86400_000).toISOString();
    const r = await Promise.all(Array.from({ length: 6 }, () => store.recordSubscriptionCharge(t.id, { subscriptionId: sub.id, periodIndex: 1, amount: 299, status: "paid", tradeNo: "T1", raw: {}, periodEnd: end, graceUntil: grace })));
    expect(r.filter((x) => x.inserted)).toHaveLength(1);
    expect((await store.getSubscription(t.id, sub.id))!.status).toBe("active");
    expect((await store.recordSubscriptionCharge(t.id, { subscriptionId: sub.id, periodIndex: 2, amount: 299, status: "failed", tradeNo: null, raw: {}, periodEnd: end, graceUntil: grace })).status).toBe("past_due");
    expect((await store.recordSubscriptionCharge(t.id, { subscriptionId: sub.id, periodIndex: 3, amount: 299, status: "paid", tradeNo: "T3", raw: {}, periodEnd: end, graceUntil: grace })).status).toBe("active");
    // 條件式轉換：expired 之後不能回 active
    expect(await store.transitionSubscription(t.id, sub.id, ["active"], "expired", { ended_at: new Date().toISOString() })).toMatchObject({ status: "expired" });
    expect(await store.transitionSubscription(t.id, sub.id, ["past_due"], "active")).toBeNull();
    expect((await store.recordSubscriptionCharge(t.id, { subscriptionId: sub.id, periodIndex: 4, amount: 299, status: "paid", tradeNo: "T4", raw: {}, periodEnd: end, graceUntil: grace })).status).toBe("expired");
    const up = await db.from("builder_subscription_charges").update({ amount: 1 }).eq("tenant_id", t.id);
    expect(up.error?.code).toBe("42501");
    const del = await db.from("builder_subscription_charges").delete().eq("tenant_id", t.id);
    expect(del.error?.code).toBe("42501");
    expect((await store.listSubscriptionCharges(t.id, sub.id)).length).toBe(4);
    const chk = await db.rpc("builder_grant_enrollment", { p_tenant: t.id, p_course: "00000000-0000-0000-0000-000000000000", p_member: m.id, p_source: "subscription", p_order: null, p_by: "itest" });
    // 課程不存在 → FK 錯（23503），不是 check 錯（23514）：代表 source 'subscription' 已被接受
    expect(chk.error?.code).toBe("23503");
  });
});
