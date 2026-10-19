/**
 * 整合測試（npm run test:db）：第八批審查修正（migration 0037）在真 DB 上的行為。
 * - H-1：builder_subscriptions.cancel_state 接受 not_needed（check 放寬），不接受亂填。
 * - M-2：builder_mark_order_refunded 同交易釋放報名與預約（cancel_reason=refunded）。
 * - L-5：builder_qr_scan_report 的訂單轉換只算已付款／已出貨、非 sandbox、未退款的訂單。
 * 建 is_test 租戶，跑完刪除。🔴 不呼叫任何金流 API。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { createEvent, createSession, createTicketType, registerEvent } from "@/lib/services/events";
import { createSubscriptionPlan } from "@/lib/services/subscriptions";
import { generateQrLabels, recordOrderConversions, recordScan } from "@/lib/services/qrcatalog";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itrv8-${ts}`;

describe.skipIf(!enabled)("第八批審查修正（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("H-1 cancel_state not_needed；M-2 已出貨退款釋放報名；L-5 QR 報表只算已付款訂單", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["shop", "events", "subscriptions", "i18n", "qr-catalog"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "R8", orderExpireHours: 48 } });
    await configureModule(ctx, { site: slug, moduleId: "events", config: { requireEmailConfirm: false } });
    await publishSite(ctx, { site: slug, confirm: true });
    const t = (await store.getTenantBySlug(slug))!;

    // H-1
    const plan = await createSubscriptionPlan(ctx, { site: slug, name: "月費", amount: 299, interval: "month", trialDays: 0, totalPeriods: 12, entitlement: { kind: "none" } });
    const member = (await store.insertMember({ tenant_id: t.id, email: `r8-${ts}@example.com`, password_hash: "x", name: "m", phone: null }))!;
    const sub = await store.insertSubscription({ tenant_id: t.id, plan_id: plan.id, member_id: member.id, provider: "newebpay", sandbox: true, merchant_order_no: `SB${ts}R8`.toUpperCase(), amount: 299, interval: "month", total_periods: 12, short_code: null });
    const moved = await store.transitionSubscription(t.id, sub.id, ["pending"], "cancelled", { cancelled_at: new Date().toISOString(), ended_at: new Date().toISOString(), cancel_state: "not_needed" });
    expect(moved?.cancel_state).toBe("not_needed");
    const bad = await db.from("builder_subscriptions").update({ cancel_state: "whatever" }).eq("id", sub.id);
    expect(bad.error?.code).toBe("23514");

    // M-2
    await createEvent(ctx, { site: slug, slug: "clay", title: "陶藝", status: "published", confirm: true });
    const start = new Date(Date.now() + 72 * 3600_000);
    const s = await createSession(ctx, { site: slug, eventSlug: "clay", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 7200_000).toISOString(), capacity: 2, confirm: true });
    const tt = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "一般", price: 500, confirm: true });
    const r = await registerEvent({ store, baseUrl: "https://itest.example" }, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tt.id, qty: 1, contact: { name: "林測華", email: `ev-${ts}@example.com`, phone: "0912345678" }, paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    await store.transitionOrder(t.id, r.order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    await store.updateRegistration(t.id, r.registrationId!, ["held"], { status: "confirmed" });
    await store.transitionOrder(t.id, r.order.id, "paid", "fulfilled", { fulfilled_at: new Date().toISOString() });
    expect(await store.markOrderRefunded(t.id, r.order.id)).toBeTruthy();
    const reg = await db.from("builder_event_registrations").select("status, cancel_reason").eq("id", r.registrationId!).single();
    expect(reg.data).toEqual({ status: "cancelled", cancel_reason: "refunded" });

    // L-5
    const p = await createProduct(ctx, { site: slug, slug: "tea", name: "茶", price: 500, status: "published", confirm: true });
    const code = (await generateQrLabels(ctx, { site: slug, productIds: [p.id], includeSvg: false })).labels[0]!.code;
    const sc = await recordScan(store, t, { code, acceptLanguage: "ja", headers: new Headers({ "x-vercel-ip-country": "JP" }), ipHash: `r8-${ts}`, enabledLangs: [] });
    const { order } = await placeOrder({ store, baseUrl: "https://itest.example" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact: { name: "測", email: `qr-${ts}@example.com`, phone: "0912345678" }, shipping: { name: "測", phone: "0912345678", address: "台中" }, paymentMethod: "offline" } });
    expect(await recordOrderConversions(store, t, order, [sc!.scanId!])).toBe(1);
    const report = async () => (await store.qrScanReport(t.id, new Date(Date.now() - 86400_000).toISOString(), [p.id])).reduce((a, x) => a + x.orders, 0);
    expect(await report()).toBe(0);
    await store.transitionOrder(t.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    expect(await report()).toBe(1);
  });
});
