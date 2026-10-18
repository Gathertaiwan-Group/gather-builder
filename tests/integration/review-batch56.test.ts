/**
 * 整合測試（npm run test:db）：第五六批審查修正在真 DB 上的行為。
 * M6 builder_reserve_event：未確認保留每筆 1 張、每場次上限（併發也不超過）、超過改候補不佔名額；
 * L1 builder_mark_paid_sandbox 同交易退回點數／儲值金／優惠券次數；M3 手動調整每日加總；H1 帳本有 seq（重播順序）。
 * 建 is_test 租戶，跑完刪除。🔴 不寄信、不呼叫金流。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { createEvent, createSession, createTicketType, registerEvent } from "@/lib/services/events";
import { createCoupon } from "@/lib/services/coupons";
import { adjustPoints } from "@/lib/services/loyalty";
import { taipeiDayStartIso } from "@/lib/services/loyalty-time";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itrv56-${ts}`;
const H = 3600_000;

describe.skipIf(!enabled)("第五六批審查修正（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };
  const deps = { store, baseUrl: "http://itest" };

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試網站", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["events", "shop"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "RW", shippingFee: 0 } });
    await enableModule(ctx, { site: slug, moduleId: "loyalty", config: { maxRedeemPercent: 100 } });
    await enableModule(ctx, { site: slug, moduleId: "coupons", config: {} });
    await publishSite(ctx, { site: slug, confirm: true });
    await createEvent(ctx, { site: slug, slug: "ev", title: "審查", status: "published", confirm: true });
  });

  it("M6：容量 10（上限 2 筆未確認）併發 6 筆未確認免費報名 → 2 筆保留、4 筆改候補；SQL 拒絕未確認 qty 2", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "ev", startsAt: new Date(Date.now() + 72 * H).toISOString(), endsAt: new Date(Date.now() + 74 * H).toISOString(), capacity: 10, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "免費", price: 0, maxPerOrder: 4, confirm: true });
    const r = await Promise.all(Array.from({ length: 6 }, (_, i) => registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: { name: "測試者", email: `m6-${i}-${ts}@example.com`, phone: "0912345678" } } })));
    expect(r.filter((x) => x.kind === "pending")).toHaveLength(2);
    expect(r.filter((x) => x.kind === "waitlisted")).toHaveLength(4);
    const held = (await store.listRegistrations(t.id, { sessionId: s.id, status: ["held", "confirmed"], limit: 50, offset: 0 })).rows;
    expect(held.reduce((n, x) => n + x.qty, 0)).toBe(2);
    // SQL 第二道：直接呼叫 RPC 帶 pending_email、qty 2 → 拒絕
    const bad = await db.rpc("builder_reserve_event", { p_tenant: t.id, p_order: null, p_res: { session_id: s.id, ticket_type_id: tk.id, qty: 2, unit_price: 0, contact: {}, email_norm: `m6-x-${ts}@example.com`, pending_email: true, pending_cap: 100 } });
    expect(bad.error?.message).toMatch(/pending qty/);
    // 保留時間 15 分鐘
    const ttl = new Date(held[0]!.hold_expires_at!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 5000);
  });

  it("L1：builder_mark_paid_sandbox 同交易退回點數折抵與優惠券次數（冪等）", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const p = await createProduct(ctx, { site: slug, slug: "item", name: "商品", price: 500, trackInventory: false, status: "published", confirm: true });
    const m = (await store.insertMember({ tenant_id: t.id, email: `l1-${ts}@example.com`, password_hash: "x", name: "L1", phone: null }))!;
    await adjustPoints(ctx, { site: slug, memberId: m.id, amount: 100, reason: "整合測試", confirm: true });
    await createCoupon(ctx, { site: slug, code: `L1${ts}`.toUpperCase().slice(0, 30), kind: "fixed", value: 50, maxUses: 1 });
    const code = `L1${ts}`.toUpperCase().slice(0, 30);
    const { order } = await placeOrder(deps, { tenant: t, member: m, data: { items: [{ productId: p.id, qty: 1 }], contact: { name: "L1", email: m.email, phone: "0912345678" }, shipping: { name: "L1", phone: "0912345678", address: "台中" }, paymentMethod: "offline", couponCode: code, pointsToUse: 100 } });
    expect((await store.creditState("points", t.id, m.id)).available).toBe(0);
    expect((await store.getCouponByCode(t.id, code))!.used_count).toBe(1);
    expect(await store.markPaidSandbox(t.id, order.id, new Date().toISOString())).toMatchObject({ status: "paid", payment_sandbox: true });
    expect((await store.creditState("points", t.id, m.id)).available).toBe(100);
    expect((await store.getCouponByCode(t.id, code))!.used_count).toBe(0);
    // 冪等：再釋放一次不會多退
    await db.rpc("builder_release_order_credits", { p_tenant: t.id, p_order: order.id });
    await db.rpc("builder_release_coupon", { p_tenant: t.id, p_order: order.id });
    expect((await store.creditState("points", t.id, m.id)).balance).toBe(100);
    expect((await store.getCouponByCode(t.id, code))!.used_count).toBe(0);
  });

  it("M3：每日手動調整加總（sumCreditKindSince）；H1：帳本有遞增 seq", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    expect(await store.sumCreditKindSince("points", t.id, "adjust", taipeiDayStartIso())).toBe(100);
    const rows = await store.allCreditEntries("points", t.id, (await store.getMemberByEmail(t.id, `l1-${ts}@example.com`))!.id);
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});
