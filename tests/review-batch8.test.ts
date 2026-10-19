/**
 * 第八批＋金流第二輪獨立審查修正：M-1（儲值訂單不能出貨）、M-2（已出貨的活動／預約訂單退款釋放名額＋booking 取消 hook）、
 * L-1（未成團時已回報匯款的待付款單列入需聯絡）、L-2（團主自分潤比對電話／地址）、L-3（resolve_refund 對 requested 需超過 15 分鐘）。
 * H-1 在 tests/subscriptions.test.ts「第八批審查（訂閱 H-1）」；L-4／L-5 在 tests/qrcatalog.test.ts。
 * 記憶體 Store＋假的 provider。🔴 不打任何真實 API、不發起真實退款。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { fulfillOrder, markOrderPaid, refundOrder, resolveRefund } from "@/lib/services/orders";
import { createEvent, createSession, createTicketType, registerEvent } from "@/lib/services/events";
import { bookSlot, createService, setWeeklyHours } from "@/lib/services/booking";
import { createGroupBuy, inviteLeader, placeGroupBuyOrder, settleGroupBuy } from "@/lib/services/groupbuy";
import { buyTopup, createTopupPlan } from "@/lib/services/wallet";
import { addDays, taipeiDateOf } from "@/lib/booking/availability";
import type { PaymentProvider } from "@/lib/pay/types";
import type { OrderRow, Store, TenantRow } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 8).toString("base64");
});

const H = 3600_000;
const who = (n: string) => ({ name: `林${n}華`, email: `${n}@example.com`, phone: "0912345678" });
const okRefund = { refunds: 0 };
const fakeProvider = { id: "linepay", sandbox: false, refund: async () => (okRefund.refunds++, { kind: "ok" as const, refundNo: "R1", raw: {} }) } as unknown as PaymentProvider;

/** 把訂單模擬成「LINE Pay 已付款」：插一筆已付款的付款紀錄＋訂單 paid（refund_order 需要線上付款紀錄） */
async function markOnlinePaid(store: Store, tenant: TenantRow, order: OrderRow) {
  const p = await store.insertPayment({ tenant_id: tenant.id, order_id: order.id, provider: "linepay", gateway_order_no: `GBT8${order.id.replace(/-/g, "").slice(0, 16)}`, amount: order.total, sandbox: false });
  await store.transitionPayment(tenant.id, p.id, "pending", "paid", { paid_at: new Date().toISOString() });
  await store.transitionOrder(tenant.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
  return p;
}

describe("M-1：儲值訂單不能出貨", () => {
  it("fulfill_order 拒絕儲值訂單；舊資料已標出貨的儲值訂單不自動退款（不呼叫 provider）", async () => {
    const store = newStore();
    const shop = await makeShop(store, "rv8-topup");
    await enableModule(shop.ctx, { site: "rv8-topup", moduleId: "stored-value", config: {} });
    await publishSite(shop.ctx, { site: "rv8-topup", confirm: true }).catch(() => undefined);
    const member = (await store.insertMember({ tenant_id: shop.tenant.id, email: "tp@example.com", password_hash: "x", name: "會員", phone: null }))!;
    const plan = await createTopupPlan(shop.ctx, { site: "rv8-topup", name: "儲 1000", payAmount: 1000, bonusAmount: 0, status: "published", confirm: true });
    const r = await buyTopup({ store, baseUrl: "http://test.local" }, { tenant: shop.tenant, member, data: { planId: plan.id, contact: { name: "會員", phone: "0912000111" }, paymentMethod: "offline" } });
    await markOrderPaid(ctxFor(store), { site: "rv8-topup", orderNo: r.order.order_no, confirm: true });
    await expect(fulfillOrder(ctxFor(store), { site: "rv8-topup", orderNo: r.order.order_no, confirm: true })).rejects.toThrow(/儲值訂單，不需要出貨/);
    // 舊資料：直接把儲值訂單標成已出貨＋有線上付款 → refund_order 拒絕（先收回再退款做不到）
    const p = await store.insertPayment({ tenant_id: shop.tenant.id, order_id: r.order.id, provider: "linepay", gateway_order_no: "GBT8LEGACYTOPUP00001", amount: 1000, sandbox: false });
    await store.transitionPayment(shop.tenant.id, p.id, "pending", "paid", { paid_at: new Date().toISOString() });
    await store.transitionOrder(shop.tenant.id, r.order.id, "paid", "fulfilled", { fulfilled_at: new Date().toISOString() });
    const before = okRefund.refunds;
    await expect(refundOrder(ctxFor(store), { site: "rv8-topup", orderNo: r.order.order_no, confirm: true }, async () => fakeProvider)).rejects.toThrow(/無法先收回儲值金/);
    expect(okRefund.refunds).toBe(before);
  });
});

describe("M-2：已出貨的活動／預約訂單退款 → 釋放名額", () => {
  it("活動：付款→出貨→退款 → 報名改 cancelled（refunded），名額回來", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "rv8-ev", name: "活動", modules: ["events", "shop"] });
    await configureModule(ctx, { site: "rv8-ev", moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款" }, ownerEmail: "owner@example.com", orderExpireHours: 48 } });
    await configureModule(ctx, { site: "rv8-ev", moduleId: "events", config: { requireEmailConfirm: false } });
    await publishSite(ctx, { site: "rv8-ev", confirm: true });
    await createEvent(ctx, { site: "rv8-ev", slug: "clay", title: "陶藝課", status: "published", confirm: true });
    const start = new Date(Date.now() + 72 * H);
    const s = await createSession(ctx, { site: "rv8-ev", eventSlug: "clay", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * H).toISOString(), capacity: 1, confirm: true });
    const t = await createTicketType(ctx, { site: "rv8-ev", sessionId: s.id, name: "一般", price: 500, confirm: true });
    const tenant = (await store.getTenantBySlug("rv8-ev"))!;
    const deps = { store, baseUrl: "http://test.local" };
    const r = await registerEvent(deps, { tenant, member: null, data: { sessionId: s.id, ticketTypeId: t.id, qty: 1, contact: who("a"), paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    const order = (await store.getOrderById(tenant.id, r.order.id))!;
    await markOnlinePaid(store, tenant, order);
    await fulfillOrder(ctx, { site: "rv8-ev", orderNo: order.order_no, confirm: true });
    // 名額已滿：第二人只能候補
    await expect(registerEvent(deps, { tenant, member: null, data: { sessionId: s.id, ticketTypeId: t.id, qty: 1, contact: who("b"), paymentMethod: "offline" } })).rejects.toThrow();
    const out = await refundOrder(ctx, { site: "rv8-ev", orderNo: order.order_no, confirm: true }, async () => fakeProvider);
    expect(out).toMatchObject({ refunded: true, refundedAfterFulfil: true });
    const regs = (await store.listRegistrations(tenant.id, { orderId: order.id, limit: 5, offset: 0 })).rows;
    expect(regs.map((x) => [x.status, x.cancel_reason])).toEqual([["cancelled", "refunded"]]);
    await expect(registerEvent(deps, { tenant, member: null, data: { sessionId: s.id, ticketTypeId: t.id, qty: 1, contact: who("c"), paymentMethod: "offline" } })).resolves.toMatchObject({ kind: "order" });
  });

  it("預約：付款→出貨→退款 → 預約改 cancelled、時段可再約；booking 取消 hook 冪等（安全網只轉換一次）", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "rv8-bk", name: "預約", modules: ["booking", "shop"] });
    await configureModule(ctx, { site: "rv8-bk", moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款" }, ownerEmail: "owner@example.com", orderExpireHours: 48 } });
    await publishSite(ctx, { site: "rv8-bk", confirm: true });
    const svc = await createService(ctx, { site: "rv8-bk", slug: "consult", name: "諮詢", durationMin: 60, price: 1500, paymentMode: "full", status: "published", confirm: true });
    await setWeeklyHours(ctx, { site: "rv8-bk", hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })), confirm: true });
    const tenant = (await store.getTenantBySlug("rv8-bk"))!;
    const startsAt = new Date(`${addDays(taipeiDateOf(new Date()), 3)}T10:00:00+08:00`).toISOString();
    const sent: string[] = [];
    const deps = { store, baseUrl: "http://test.local", sendMail: async (_to: string, subject: string) => void sent.push(subject) };
    const b = await bookSlot(deps, { tenant, member: null, data: { serviceId: svc.id, startsAt, contact: who("a"), paymentMethod: "offline" } });
    if (b.kind !== "order") throw new Error("expected order");
    const order = (await store.getOrderById(tenant.id, b.order.id))!;
    await markOnlinePaid(store, tenant, order);
    await fulfillOrder(ctx, { site: "rv8-bk", orderNo: order.order_no, confirm: true });
    await expect(bookSlot(deps, { tenant, member: null, data: { serviceId: svc.id, startsAt, contact: who("b"), paymentMethod: "offline" } })).rejects.toThrow();
    await refundOrder({ ...ctx, sendMail: deps.sendMail }, { site: "rv8-bk", orderNo: order.order_no, confirm: true }, async () => fakeProvider);
    expect((await store.getBooking(tenant.id, b.bookingId!))!).toMatchObject({ status: "cancelled", cancel_reason: "refunded" });
    await expect(bookSlot(deps, { tenant, member: null, data: { serviceId: svc.id, startsAt, contact: who("c"), paymentMethod: "offline" } })).resolves.toBeTruthy();
  });
});

describe("L-1／L-2：團購", () => {
  async function gb(store: Store, slug: string, minQty: number | null) {
    const shop = await makeShop(store, slug);
    await enableModule(shop.ctx, { site: slug, moduleId: "group-buy", config: {} });
    const sent: { to: string; subject: string; body: string }[] = [];
    const ctx = { ...shop.ctx, sendMail: async (to: string, subject: string, body: string) => void sent.push({ to, subject, body }) };
    const g = await createGroupBuy(ctx, { site: slug, slug: "autumn", title: "秋季團購", endsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), minQty, pickupPoints: [], items: [{ productId: shop.mug.id, price: 280, quota: null }], status: "published", confirm: true });
    const deps = { store, baseUrl: "http://test.local", sendMail: ctx.sendMail };
    const order = (email: string, extra: Record<string, unknown> = {}) =>
      placeGroupBuyOrder(deps, { tenant: shop.tenant, member: null, slug: "autumn", data: { items: [{ itemId: g.items[0]!.id, qty: 1 }], contact: { name: "王小明", email, phone: "0912345678" }, shipping: { name: "王小明", phone: "0912345678", address: "台北市中正區八德路一段 1 號" }, paymentMethod: "offline", ...extra } });
    return { ...shop, ctx, g, sent, deps, order };
  }

  it("L-1：未成團 → 回報過匯款末五碼的待付款單：客人信說明會處理已匯款項（不說不需付款）；店主摘要列出需聯絡", async () => {
    const store = newStore();
    const s = await gb(store, "rv8-gb-l1", 5);
    const a = await s.order("a@example.com", { payerLast5: "12345" });
    const b = await s.order("b@example.com");
    const g = (await store.getGroupBuy(s.tenant.id, s.g.id))!;
    await settleGroupBuy(s.deps, s.tenant, g, { force: true });
    const toA = s.sent.find((m) => m.to === "a@example.com" && m.subject.includes("未成團"))!;
    const toB = s.sent.find((m) => m.to === "b@example.com" && m.subject.includes("未成團"))!;
    expect(toA.body).toMatch(/已回報匯款/);
    expect(toA.body).not.toMatch(/不需再付款/);
    expect(toB.body).toMatch(/不需再付款/);
    const owner = s.sent.find((m) => m.to !== "a@example.com" && m.to !== "b@example.com" && m.subject.includes("未成團"))!;
    expect(owner.body).toContain(a.order.order_no);
    expect(owner.body).not.toContain(b.order.order_no);
  });

  it("L-2：團主用別的 email 但電話或收件地址與團主會員帳號以前的訂單相同 → 不記團主分潤", async () => {
    const store = newStore();
    const s = await gb(store, "rv8-gb-l2", null);
    const lead = await inviteLeader(s.ctx, { site: "rv8-gb-l2", groupBuyId: s.g.id, name: "阿美", email: "leader@example.com", commissionPercent: 10 });
    const leaderMember = (await store.insertMember({ tenant_id: s.tenant.id, email: "leader@example.com", password_hash: "x", name: "阿美", phone: "0977-123-456" }))!;
    await placeOrder({ store, baseUrl: "http://test.local" }, { tenant: s.tenant, member: leaderMember, data: { items: [{ productId: s.mug.id, qty: 1 }], contact: { name: "阿美", email: "leader@example.com", phone: "0977123456" }, shipping: { name: "阿美", phone: "0977123456", address: "新北市板橋區文化路一段 100 號" }, paymentMethod: "offline" } });
    // 同電話（格式不同）
    const byPhone = await s.order("alias1@example.com", { leaderCode: lead.code, contact: { name: "阿美", email: "alias1@example.com", phone: "+886 977 123 456" } });
    expect(byPhone.order.group_buy_leader_id).toBeNull();
    // 同地址（空白、全形不同）
    const byAddr = await s.order("alias2@example.com", { leaderCode: lead.code, contact: { name: "阿美", email: "alias2@example.com", phone: "0900000000" }, shipping: { name: "阿美", phone: "0900000000", address: "新北市板橋區文化路一段１００號" } });
    expect(byAddr.order.group_buy_leader_id).toBeNull();
    // 一般客人照常記團主
    const normal = await s.order("someone@example.com", { leaderCode: lead.code, contact: { name: "路人", email: "someone@example.com", phone: "0911222333" }, shipping: { name: "路人", phone: "0911222333", address: "台中市西區民權路 1 號" } });
    expect(normal.order.group_buy_leader_id).toBe(lead.leaderId);
  });
});

describe("L-3：resolve_refund 對 requested", () => {
  it("送出不到 15 分鐘的 requested 退款不能人工標記；超過才可以", async () => {
    const store = newStore();
    const shop = await makeShop(store, "rv8-l3");
    const { order } = await placeOrder({ store, baseUrl: "http://test.local" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact: who("x"), shipping: { name: "林x華", phone: "0912345678", address: "台中市" }, paymentMethod: "offline" } });
    const p = await markOnlinePaid(store, shop.tenant, order);
    const rf = await store.insertRefund({ tenant_id: shop.tenant.id, order_id: order.id, payment_id: p.id, provider: "linepay", amount: order.total, requested_by: "test", reason: null });
    await expect(resolveRefund(ctxFor(store), { site: "rv8-l3", refundId: rf.id, outcome: "failed", confirm: true })).rejects.toThrow(/不到 15 分鐘/);
    (await store.getRefund(shop.tenant.id, rf.id))!; // 存在
    const old = { ...store, getRefund: async (t: string, id: string) => ({ ...(await store.getRefund(t, id))!, created_at: new Date(Date.now() - 20 * 60_000).toISOString() }) } as Store;
    await expect(resolveRefund(ctxFor(old), { site: "rv8-l3", refundId: rf.id, outcome: "failed", confirm: true })).resolves.toMatchObject({ status: "failed" });
  });
});
