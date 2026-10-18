/**
 * 第四批獨立審查修正（記憶體 Store）：M2 hook 失敗補做、M3 sandbox 不佔名額、M4 遞補連結不可轉讓、
 * M5 免費報名／候補 email 確認與每 email 上限、L1 全形 CSV、L2 系統取消跑 hooks、L3 遞補略過停售票種、
 * L4 取消場次先標 cancelled、L5 首單判斷正規化 email、L6 報名成功網址不帶個資、L7 確認信顯示實付、L8 改期縮短付款期限。
 * 真 DB 的部分在 tests/integration/review-batch4.test.ts。🔴 全部用假寄信、mock 金流。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { cancelOrderWithHooks, handlePchomepayNotify, markOrderPaid, retryOrderHooks, savePaymentAccount, startPchomepayPayment } from "@/lib/services/orders";
import { cancelSession, confirmEventEmail, createEvent, createSession, createTicketType, joinWaitlist, registerEvent, updateEvent } from "@/lib/services/events";
import { bookSlot, createService, selfRescheduleBooking, setWeeklyHours, manageToken } from "@/lib/services/booking";
import { csvCell, signFor } from "@/lib/services/class-orders";
import { registerOrderHooks } from "@/lib/services/order-hooks";
import { handleEventRegister } from "@/lib/class-routes";
import { addDays, taipeiDateOf } from "@/lib/booking/availability";
import type { PchomepayClient, PchomepayQuery } from "@/lib/pay/pchomepay";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => vi.useRealTimers());

const H = 3600_000;
const who = (n: string) => ({ name: `林${n}華`, email: `${n}@example.com`, phone: "0912345678" });
function mailbox() {
  const sent: { to: string; subject: string; text: string }[] = [];
  return { sent, sendMail: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) };
}

async function eventSite(store: Store, slug: string, opts: { capacity?: number; price?: number; requireEmailConfirm?: boolean } = {}) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: `活動 ${slug}`, modules: ["events", "shop"] });
  await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款" }, ownerEmail: "owner@example.com", orderExpireHours: 48 } });
  if (opts.requireEmailConfirm !== undefined) await configureModule(ctx, { site: slug, moduleId: "events", config: { requireEmailConfirm: opts.requireEmailConfirm } });
  await publishSite(ctx, { site: slug, confirm: true });
  await createEvent(ctx, { site: slug, slug: "clay", title: "陶藝課", status: "published", confirm: true });
  const start = new Date(Date.now() + 72 * H);
  const s = await createSession(ctx, { site: slug, eventSlug: "clay", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * H).toISOString(), capacity: opts.capacity ?? 1, confirm: true });
  const t = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "一般", price: opts.price ?? 0, confirm: true });
  return { ctx, tenant: (await store.getTenantBySlug(slug))!, s, t };
}

const deps = (store: Store, mb = mailbox()) => ({ store, baseUrl: "http://test.local", sendMail: mb.sendMail });

describe("M2：付款後 hook 失敗會記錄並補做", () => {
  it("報名確認 hook 失敗 → 留下失敗紀錄、報名仍 held；cron 補做後確認並寄信；補做冪等", async () => {
    const store = newStore();
    const x = await eventSite(store, "m2-retry", { price: 500, requireEmailConfirm: false });
    const mb = mailbox();
    const r = await registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("a"), paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    // 模擬 DB 暫時故障：確認報名的寫入第一次丟錯
    const orig = store.updateRegistration.bind(store);
    let failOnce = true;
    store.updateRegistration = async (...a) => {
      if (failOnce && a[3].status === "confirmed") {
        failOnce = false;
        throw new Error("simulated db outage");
      }
      return orig(...a);
    };
    await markOrderPaid({ ...ctxFor(store), sendMail: mb.sendMail }, { site: "m2-retry", orderNo: r.order.order_no, confirm: true });
    expect((await store.getRegistration(x.tenant.id, r.registrationId!))!.status).toBe("held");
    const open = await store.listOpenHookFailures({ limit: 10, maxAttempts: 20 });
    expect(open).toMatchObject([{ hook: "events", event: "paid", attempts: 1 }]);
    const res = await retryOrderHooks(deps(store, mb));
    expect(res).toMatchObject({ scanned: 1, resolved: 1, failed: 0 });
    expect((await store.getRegistration(x.tenant.id, r.registrationId!))!.status).toBe("confirmed");
    expect(mb.sent.some((m) => m.subject.includes("報名成功"))).toBe(true);
    expect(await retryOrderHooks(deps(store, mb))).toMatchObject({ scanned: 0 });
  });

  it("一直失敗的 hook：第 3 次起警示店主、只寄一次；訂單後來取消 → 紀錄標為不再適用", async () => {
    const store = newStore();
    const x = await eventSite(store, "m2-alert", { price: 500, requireEmailConfirm: false });
    registerOrderHooks({ name: "zz-always-fail", paid: async () => { throw new Error("boom"); } });
    try {
      const mb = mailbox();
      const r = await registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("b"), paymentMethod: "offline" } });
      if (r.kind !== "order") throw new Error("expected order");
      await markOrderPaid({ ...ctxFor(store), sendMail: mb.sendMail }, { site: "m2-alert", orderNo: r.order.order_no, confirm: true });
      for (let i = 0; i < 4; i++) await retryOrderHooks(deps(store, mb));
      const alerts = mb.sent.filter((m) => m.to === "owner@example.com" && m.subject.includes("處理失敗"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.subject).toContain("zz-always-fail");
      await cancelOrderWithHooks(deps(store, mb), x.tenant, r.order.id, ["paid"], "test");
      expect(await retryOrderHooks(deps(store, mb))).toMatchObject({ resolved: 1 });
      expect(await store.listOpenHookFailures({ limit: 10, maxAttempts: 20 })).toHaveLength(0);
    } finally {
      registerOrderHooks({ name: "zz-always-fail" });
    }
  });
});

describe("M3：sandbox 付款不佔名額", () => {
  it("sandbox 付款成功 → 訂單 paid＋payment_sandbox，報名同時釋放（cancelled），名額回來給別人", async () => {
    const store = newStore();
    const x = await eventSite(store, "m3-sbx", { price: 500, requireEmailConfirm: false });
    await savePaymentAccount(ctxFor(store), { site: "m3-sbx", appId: "APPIDSBX", secret: "secret-value-123", sandbox: true });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const r = await registerEvent(deps(store), { tenant: x.tenant, member: null, allowSandbox: true, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("c"), paymentMethod: "pchomepay" } });
    if (r.kind !== "order") throw new Error("expected order");
    const factory = async () => ({ sandbox: true, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/x" }) } as unknown as PchomepayClient });
    const pay = await startPchomepayPayment({ store, baseUrl: "http://t", clientFactory: factory }, { tenant: x.tenant, order: r.order, accessKey: r.accessKey });
    const q: PchomepayQuery = { status: "S", status_code: undefined, amount: r.order.total, raw: {} };
    const out = await handlePchomepayNotify({ store, baseUrl: "http://t", queryFor: async () => ({ queryPayment: async () => q }) }, { tenantId: x.tenant.id, rawBody: new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: pay.gatewayOrderNo }) }).toString() });
    expect(out.outcome).toBe("paid");
    const o = (await store.getOrderById(x.tenant.id, r.order.id))!;
    expect(o).toMatchObject({ status: "paid", payment_sandbox: true });
    expect((await store.getRegistration(x.tenant.id, r.registrationId!))!).toMatchObject({ status: "cancelled", cancel_reason: "sandbox_payment" });
    // 唯一的名額已回來
    await expect(registerEvent(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("d"), paymentMethod: "offline" } })).resolves.toMatchObject({ kind: "order" });
  });
});

describe("M4：遞補連結不可轉讓", () => {
  it("別人拿到 B 的遞補連結 → 拒絕；B 本人（同 email、gmail 加點也算）→ 成功", async () => {
    const store = newStore();
    const x = await eventSite(store, "m4-offer", { price: 300, requireEmailConfirm: false });
    const mb = mailbox();
    const a = await registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("a"), paymentMethod: "offline" } });
    if (a.kind !== "order") throw new Error("expected order");
    const bContact = { name: "B 先生", email: "bob.lee@gmail.com", phone: "0912345678" };
    const w = await joinWaitlist(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: bContact } });
    await cancelOrderWithHooks(deps(store, mb), x.tenant, a.order.id, ["pending_payment"], "test");
    const offer = (await store.getWaitlist(x.tenant.id, w.waitlistId))!;
    expect(offer.status).toBe("offered");
    const token = signFor("offer", offer.id);
    const claim = (contact: typeof bContact) => registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact, paymentMethod: "offline", offerId: offer.id, offerToken: token } });
    await expect(claim({ name: "C", email: "c@example.com", phone: "0912345678" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(claim({ ...bContact, email: "boblee+x@gmail.com" })).resolves.toMatchObject({ kind: "order" });
  });
});

describe("M5：免費報名／候補 email 確認、每 email 上限", () => {
  it("預設要確認：先 held（佔名額 30 分）→ 點確認才 confirmed；同 email 再報被拒；逾期未確認名額釋出", async () => {
    const store = newStore();
    const x = await eventSite(store, "m5-free", { capacity: 1 });
    const mb = mailbox();
    const r = await registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("e") } });
    expect(r.kind).toBe("pending");
    if (r.kind !== "pending") return;
    expect(r.registration.status).toBe("held");
    const mail = mb.sent.find((m) => m.subject.includes("請確認報名"))!;
    expect(mail.text).toContain("/events/confirm?r=");
    expect(mail.text).not.toMatch(/簽到碼/);
    // 名額被保留：別人報不到
    await expect(registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("f") } })).rejects.toThrow(/名額已滿/);
    // 錯的簽章
    await expect(confirmEventEmail(deps(store, mb), { tenant: x.tenant, kind: "r", id: r.registration.id, token: "x".repeat(32) })).rejects.toThrow(/無效或已過期/);
    const ok = await confirmEventEmail(deps(store, mb), { tenant: x.tenant, kind: "r", id: r.registration.id, token: signFor("event-confirm-r", r.registration.id) });
    expect(ok).toMatchObject({ kind: "registration", already: false, registration: { status: "confirmed" } });
    expect(mb.sent.some((m) => m.subject.includes("報名成功") && m.text.includes("簽到碼"))).toBe(true);
    // 同 email（gmail 規則外的一般信箱：大小寫不同也算同一人）再報 → 拒絕
    const x2 = await eventSite(store, "m5-free2", { capacity: 5 });
    await registerEvent(deps(store, mb), { tenant: x2.tenant, member: null, data: { sessionId: x2.s.id, ticketTypeId: x2.t.id, qty: 1, contact: who("g") } });
    await expect(registerEvent(deps(store, mb), { tenant: x2.tenant, member: null, data: { sessionId: x2.s.id, ticketTypeId: x2.t.id, qty: 1, contact: { ...who("g"), email: "G@Example.com" } } })).rejects.toThrow(/已報名過/);
  });

  it("逾期未確認：名額釋出、確認連結失效、本人可重新報名", async () => {
    const store = newStore();
    const x = await eventSite(store, "m5-exp", { capacity: 1 });
    const mb = mailbox();
    const r = await registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("h") } });
    if (r.kind !== "pending") throw new Error("expected pending");
    vi.useFakeTimers({ now: Date.now() + 31 * 60_000 });
    await expect(confirmEventEmail(deps(store, mb), { tenant: x.tenant, kind: "r", id: r.registration.id, token: signFor("event-confirm-r", r.registration.id) })).rejects.toThrow(/已過期/);
    const again = await registerEvent(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("i") } });
    expect(again.kind).toBe("pending");
    expect((await store.getRegistration(x.tenant.id, r.registration.id))!.status).toBe("expired");
  });

  it("已驗證 email 的會員免確認；候補要確認後才排入順序", async () => {
    const store = newStore();
    const x = await eventSite(store, "m5-wl", { capacity: 1 });
    const mb = mailbox();
    const m = (await store.insertMember({ tenant_id: x.tenant.id, email: "member@example.com", password_hash: "x", name: "會員", phone: null }))!;
    await store.updateMember(x.tenant.id, m.id, { email_verified_at: new Date().toISOString() });
    const member = (await store.getMemberById(x.tenant.id, m.id))!;
    const r = await registerEvent(deps(store, mb), { tenant: x.tenant, member, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: { name: "會員", email: "member@example.com", phone: "0912345678" } } });
    expect(r.kind).toBe("free");
    const w = await joinWaitlist(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("j") } });
    expect(w.pendingEmail).toBe(true);
    expect((await store.getWaitlist(x.tenant.id, w.waitlistId))!.status).toBe("unconfirmed");
    await confirmEventEmail(deps(store, mb), { tenant: x.tenant, kind: "w", id: w.waitlistId, token: signFor("event-confirm-w", w.waitlistId) });
    expect((await store.getWaitlist(x.tenant.id, w.waitlistId))!.status).toBe("waiting");
    // 已報名的 email 不能再排候補
    await expect(joinWaitlist(deps(store, mb), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: { name: "會員", email: "member@example.com", phone: "0912345678" } } })).rejects.toThrow(/已報名過/);
  });

  it("免費預約：每個 email（正規化）每天上限 2 筆", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "m5-book", name: "預約", modules: ["booking"] });
    await publishSite(ctx, { site: "m5-book", confirm: true });
    const svc = await createService(ctx, { site: "m5-book", slug: "free", name: "免費諮詢", durationMin: 30, bufferMin: 0, price: 0, status: "published", confirm: true });
    await setWeeklyHours(ctx, { site: "m5-book", hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })), confirm: true });
    const tenant = (await store.getTenantBySlug("m5-book"))!;
    const d = addDays(taipeiDateOf(new Date()), 3);
    const book = (hm: string, email: string) => bookSlot(deps(store), { tenant, member: null, data: { serviceId: svc.id, startsAt: new Date(`${d}T${hm}:00+08:00`).toISOString(), contact: { name: "陳小明", email, phone: "0912345678" } } });
    await book("10:00", "spam.mer@gmail.com");
    await book("11:00", "spammer+2@gmail.com");
    await expect(book("12:00", "SPAMMER@googlemail.com")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(book("12:00", "someone@example.com")).resolves.toMatchObject({ kind: "confirmed" });
  });
});

describe("Low", () => {
  it("L1：全形 ＝＋－＠ 開頭也加單引號", () => {
    for (const c of ["＝SUM(A1)", "＋1", "－1", "＠x"]) expect(csvCell(c)).toBe(`"'${c}"`);
  });

  it("L2：cancelOrderWithHooks 會跑取消 hooks（名額釋放後遞補候補）", async () => {
    const store = newStore();
    const x = await eventSite(store, "l2-hooks", { price: 300, requireEmailConfirm: false });
    const a = await registerEvent(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("a"), paymentMethod: "offline" } });
    if (a.kind !== "order") throw new Error("expected order");
    const w = await joinWaitlist(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("b") } });
    await cancelOrderWithHooks(deps(store), x.tenant, a.order.id, ["pending_payment"], "payment_init_failed");
    expect((await store.getWaitlist(x.tenant.id, w.waitlistId))!.status).toBe("offered");
  });

  it("L3：遞補略過停售票種的候補者，下一位照常遞補", async () => {
    const store = newStore();
    const x = await eventSite(store, "l3-skip", { price: 300, requireEmailConfirm: false });
    const t2 = await createTicketType(x.ctx, { site: "l3-skip", sessionId: x.s.id, name: "早鳥", price: 300, confirm: true });
    const a = await registerEvent(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("a"), paymentMethod: "offline" } });
    if (a.kind !== "order") throw new Error("expected order");
    const w1 = await joinWaitlist(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: t2.id, qty: 1, contact: who("b") } });
    const w2 = await joinWaitlist(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("c") } });
    await store.updateTicketType(x.tenant.id, t2.id, { active: false });
    await cancelOrderWithHooks(deps(store), x.tenant, a.order.id, ["pending_payment"], "test");
    expect((await store.getWaitlist(x.tenant.id, w1.waitlistId))!.status).toBe("waiting");
    expect((await store.getWaitlist(x.tenant.id, w2.waitlistId))!.status).toBe("offered");
  });

  it("L4：取消場次時先把場次標 cancelled 才列報名", async () => {
    const store = newStore();
    const x = await eventSite(store, "l4-order", { capacity: 3, requireEmailConfirm: false });
    await registerEvent(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: who("a") } });
    const seen: string[] = [];
    const orig = store.listRegistrations.bind(store);
    store.listRegistrations = async (tid, opts) => {
      if (opts.sessionId) seen.push((await store.getSession(tid, opts.sessionId))!.status);
      return orig(tid, opts);
    };
    const r = await cancelSession(x.ctx, { site: "l4-order", sessionId: x.s.id, confirm: true });
    expect(r.notified).toBe(1);
    expect(seen.at(-1)).toBe("cancelled");
  });

  it("L5：首單判斷（countPaidOrdersFor）用正規化 email", async () => {
    const store = newStore();
    const x = await eventSite(store, "l5-norm", { price: 300, requireEmailConfirm: false });
    const a = await registerEvent(deps(store), { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, qty: 1, contact: { name: "王小明", email: "Wang.Ming@gmail.com", phone: "0912345678" }, paymentMethod: "offline" } });
    if (a.kind !== "order") throw new Error("expected order");
    await markOrderPaid(ctxFor(store), { site: "l5-norm", orderNo: a.order.order_no, confirm: true });
    expect(await store.countPaidOrdersFor(x.tenant.id, { memberId: null, email: "wangming+promo@googlemail.com" }, "00000000-0000-0000-0000-000000000000")).toBe(1);
  });

  it("L6：免費報名成功的 303 網址不含 email 與簽到碼", async () => {
    const store = newStore();
    const x = await eventSite(store, "l6-url", { capacity: 3, requireEmailConfirm: false });
    const fd = new URLSearchParams({ sessionId: x.s.id, ticketTypeId: x.t.id, qty: "1", name: "王小明", email: "leak@example.com", phone: "0912345678" });
    const req = new Request("http://test.local/s/l6-url/api/events/register", { method: "POST", body: fd, headers: { origin: "http://test.local", "content-type": "application/x-www-form-urlencoded" } });
    const res = await handleEventRegister(req, "l6-url", store);
    expect(res.status).toBe(303);
    const loc = decodeURIComponent(res.headers.get("location") ?? "");
    expect(loc).toContain("報名成功");
    expect(loc).not.toContain("leak@example.com");
    expect(loc).not.toMatch(/簽到碼 [A-Z0-9]{10}/);
  });

  it("L7＋L8：訂金預約付款後確認信顯示訂單實付；未付款保留改期 → 付款期限不晚於新時段", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "l78-book", name: "預約", modules: ["booking", "shop"] });
    await configureModule(ctx, { site: "l78-book", moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款" }, orderExpireHours: 72 } });
    await configureModule(ctx, { site: "l78-book", moduleId: "booking", config: { cancelDeadlineHours: 0, minLeadMinutes: 0 } });
    await publishSite(ctx, { site: "l78-book", confirm: true });
    const svc = await createService(ctx, { site: "l78-book", slug: "dep", name: "諮詢", durationMin: 60, bufferMin: 0, price: 2000, paymentMode: "deposit", depositAmount: 500, status: "published", confirm: true });
    await setWeeklyHours(ctx, { site: "l78-book", hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })), confirm: true });
    const tenant = (await store.getTenantBySlug("l78-book"))!;
    const mb = mailbox();
    const d = addDays(taipeiDateOf(new Date()), 5);
    const r = await bookSlot(deps(store, mb), { tenant, member: null, data: { serviceId: svc.id, startsAt: new Date(`${d}T10:00:00+08:00`).toISOString(), contact: who("k"), paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    // L8：改到明天（台北）——比 72 小時的付款期限更早開始
    const tomorrow = addDays(taipeiDateOf(new Date()), 1);
    const newStart = new Date(`${tomorrow}T17:00:00+08:00`).toISOString();
    await selfRescheduleBooking(deps(store, mb), { tenant, bookingId: r.bookingId, token: manageToken({ id: r.bookingId! }), startsAt: newStart });
    const o = (await store.getOrderById(tenant.id, r.order.id))!;
    expect(new Date(o.expires_at!).getTime()).toBeLessThanOrEqual(new Date(newStart).getTime());
    // L7
    await markOrderPaid({ ...ctxFor(store), sendMail: mb.sendMail }, { site: "l78-book", orderNo: r.order.order_no, confirm: true });
    const mail = mb.sent.filter((m) => m.subject.includes("預約成功")).at(-1)!;
    expect(mail.text).toContain(`已付：NT$${o.total}`);
  });
});

describe("events：slug confirm 保留給確認頁", () => {
  it("建立或改成 slug confirm 被拒", async () => {
    const store = newStore();
    const x = await eventSite(store, "slug-confirm");
    await expect(createEvent(x.ctx, { site: "slug-confirm", slug: "confirm", title: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(updateEvent(x.ctx, { site: "slug-confirm", slug: "clay", patch: { slug: "confirm" }, confirm: true })).rejects.toMatchObject({ code: "invalid" });
  });
});
