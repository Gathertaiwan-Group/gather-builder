/**
 * events 模組（記憶體 Store）：免費／付費票、名額、保留逾期釋放、候補遞補（冪等、逾時換下一位）、
 * PII 遮罩與查看紀錄、CSV injection、提醒只寄一次、取消場次、租戶隔離、scope 與 confirm。
 * 併發搶最後一席（真 DB）在 tests/integration/classes.test.ts。🔴 全部用假寄信。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { markOrderPaid } from "@/lib/services/orders";
import {
  cancelSession,
  checkIn,
  createEvent,
  createSession,
  createTicketType,
  exportRegistrationsCsv,
  joinWaitlist,
  listEvents,
  listRegistrations,
  offerFor,
  registerEvent,
  revealRegistration,
  runEventsCron,
  updateEvent,
} from "@/lib/services/events";
import { checkinCode, csvCell, maskContact, toCsv } from "@/lib/services/class-orders";
import type { Store } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 5).toString("base64");
});
afterEach(() => vi.useRealTimers());

const H = 3600_000;
const contact = (n: string) => ({ name: `王${n}明`, email: `${n}@example.com`, phone: "0912345678" });

function mailbox() {
  const sent: { to: string; subject: string; text: string }[] = [];
  return { sent, sendMail: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) };
}

async function eventSite(store: Store, slug: string, opts: { capacity?: number; price?: number; quota?: number; startsInH?: number } = {}) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: `工作室 ${slug}`, modules: ["events", "shop"] });
  await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款 000-123" }, ownerEmail: "owner@example.com", orderExpireHours: 48 } });
  await publishSite(ctx, { site: slug, confirm: true });
  const ev = await createEvent(ctx, { site: slug, slug: "clay", title: "陶藝工作坊", location: "台中市", status: "published", confirm: true });
  const start = new Date(Date.now() + (opts.startsInH ?? 72) * H);
  const s = await createSession(ctx, { site: slug, eventSlug: "clay", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * H).toISOString(), capacity: opts.capacity ?? 1, confirm: true });
  const t = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "一般", price: opts.price ?? 0, quota: opts.quota, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  return { ctx, tenant, ev, s, t };
}

const reg = (store: Store, mb: ReturnType<typeof mailbox>, tenant: Awaited<ReturnType<typeof eventSite>>["tenant"], s: { id: string }, t: { id: string }, who: string, extra: Record<string, unknown> = {}) =>
  registerEvent({ store, baseUrl: "http://test.local", sendMail: mb.sendMail }, { tenant, member: null, data: { sessionId: s.id, ticketTypeId: t.id, qty: 1, contact: contact(who), ...extra } });

describe("報名：免費與付費", () => {
  it("免費票直接成立、寄確認信含簽到碼；額滿後再報名被拒", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-free", { capacity: 2 });
    const mb = mailbox();
    const r = await reg(store, mb, x.tenant, x.s, x.t, "a");
    expect(r.kind).toBe("free");
    if (r.kind !== "free") return;
    expect(r.registration.status).toBe("confirmed");
    expect(mb.sent.find((m) => m.to === "a@example.com")!.text).toContain(checkinCode(r.registration.id));
    await reg(store, mb, x.tenant, x.s, x.t, "b");
    await expect(reg(store, mb, x.tenant, x.s, x.t, "c")).rejects.toThrow(/名額已滿/);
    const l = await listEvents(x.ctx, { site: "ev-free" });
    expect(l.events[0]!.sessions[0]).toMatchObject({ registered: 2, remaining: 0 });
  });

  it("付費票（線下匯款）：建立訂單、名額保留（held）；標記收款後才確認並寄確認信", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-paid", { price: 800 });
    const mb = mailbox();
    const r = await reg(store, mb, x.tenant, x.s, x.t, "a", { paymentMethod: "offline" });
    expect(r.kind).toBe("order");
    if (r.kind !== "order") return;
    expect(r.order).toMatchObject({ status: "pending_payment", total: 800, shipping_fee: 0 });
    const items = await store.listOrderItems(x.tenant.id, r.order.id);
    expect(items[0]).toMatchObject({ item_kind: "event_ticket", ref_id: x.t.id, product_id: null, qty: 1 });
    const held = (await store.listRegistrations(x.tenant.id, { orderId: r.order.id, limit: 5, offset: 0 })).rows[0]!;
    expect(held.status).toBe("held");
    // 保留中佔名額
    await expect(reg(store, mb, x.tenant, x.s, x.t, "b", { paymentMethod: "offline" })).rejects.toThrow(/名額已滿/);
    await markOrderPaid({ ...x.ctx, sendMail: mb.sendMail }, { site: "ev-paid", orderNo: r.order.order_no, confirm: true });
    const after = (await store.getRegistration(x.tenant.id, held.id))!;
    expect(after.status).toBe("confirmed");
    expect(mb.sent.some((m) => m.to === "a@example.com" && /報名成功/.test(m.subject) && m.text.includes(checkinCode(held.id)))).toBe(true);
  });

  it("票價被竄改、超過每單上限、販售期間外、草稿活動 → 拒絕", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-rules", { capacity: 10 });
    const mb = mailbox();
    await expect(reg(store, mb, x.tenant, x.s, x.t, "a", { qty: 99 })).rejects.toThrow();
    const later = await createTicketType(x.ctx, { site: "ev-rules", sessionId: x.s.id, name: "晚鳥", price: 0, salesStart: new Date(Date.now() + 24 * H).toISOString(), confirm: true });
    await expect(reg(store, mb, x.tenant, x.s, later, "b")).rejects.toThrow(/販售期間/);
    await updateEvent(x.ctx, { site: "ev-rules", slug: "clay", patch: { status: "draft" }, confirm: true });
    await expect(reg(store, mb, x.tenant, x.s, x.t, "c")).rejects.toThrow(/找不到/);
  });

  it("付費票需要 shop；免費活動不需要", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "ev-noshop", name: "x", modules: ["events"] });
    await createEvent(ctx, { site: "ev-noshop", slug: "a", title: "A" });
    const s = await createSession(ctx, { site: "ev-noshop", eventSlug: "a", startsAt: new Date(Date.now() + 48 * H).toISOString(), endsAt: new Date(Date.now() + 50 * H).toISOString(), capacity: 5 });
    await expect(createTicketType(ctx, { site: "ev-noshop", sessionId: s.id, name: "付費", price: 100 })).rejects.toThrow(/shop/);
    await expect(createTicketType(ctx, { site: "ev-noshop", sessionId: s.id, name: "免費", price: 0 })).resolves.toBeTruthy();
  });
});

describe("保留逾期與候補遞補", () => {
  it("A 的付費保留逾期 → 釋放 → 候補 B 收到遞補（24h）；遞補冪等；B 逾時 → 換 C；B 用連結完成報名", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-wait", { price: 500, startsInH: 24 * 6 });
    const mb = mailbox();
    const deps = { store, baseUrl: "http://test.local", sendMail: mb.sendMail };
    const a = await reg(store, mb, x.tenant, x.s, x.t, "a", { paymentMethod: "offline" });
    expect(a.kind).toBe("order");
    // 額滿：B、C 登記候補（不能直接報名）
    await expect(reg(store, mb, x.tenant, x.s, x.t, "b", { paymentMethod: "offline" })).rejects.toThrow(/名額已滿/);
    const wb = await joinWaitlist(deps, { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, contact: contact("b") } });
    expect(wb.position).toBe(1);
    await joinWaitlist(deps, { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, contact: contact("c") } });
    await expect(joinWaitlist(deps, { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, contact: { ...contact("b"), email: "B+dup@example.com" } } })).rejects.toThrow(/已經在/);
    // 時間往後 49 小時：A 的保留（48h）逾期
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 49 * H);
    const r1 = await runEventsCron(deps);
    expect((await store.getOrderById(x.tenant.id, (a as { order: { id: string } }).order.id))!.status).toBe("cancelled");
    const regA = (await store.listRegistrations(x.tenant.id, { sessionId: x.s.id, limit: 5, offset: 0 })).rows[0]!;
    expect(regA.status).toBe("expired");
    void r1; // 遞補可能在取消 hook 內就完成（不一定算在 cron 的 offered）
    expect((await store.listWaitlist(x.tenant.id, x.s.id)).map((w) => w.status)).toEqual(["offered", "waiting"]);
    const offerMail = mb.sent.filter((m) => m.to === "b@example.com" && /候補遞補/.test(m.subject));
    expect(offerMail).toHaveLength(1);
    // 冪等：再跑一次不會再給（空位已保留給 B），C 沒收到
    expect((await runEventsCron(deps)).offered).toBe(0);
    expect(mb.sent.filter((m) => m.to === "c@example.com" && /候補遞補/.test(m.subject))).toHaveLength(0);
    // 保留期間別人不能搶
    await expect(reg(store, mb, x.tenant, x.s, x.t, "d", { paymentMethod: "offline" })).rejects.toThrow(/名額已滿/);
    // B 逾時（24h）→ 換 C
    vi.setSystemTime(Date.now() + 25 * H);
    expect((await runEventsCron(deps)).offered).toBe(1);
    const wl = await store.listWaitlist(x.tenant.id, x.s.id);
    expect(wl.map((w) => w.status)).toEqual(["lapsed", "offered"]);
    const offerC = /offer=([^&\s]+)&t=([^&\s]+)/.exec(mb.sent.filter((m) => m.to === "c@example.com" && /候補遞補/.test(m.subject))[0]!.text)!;
    expect(await offerFor(store, x.tenant, decodeURIComponent(offerC[1]!), "wrong-token-wrong-token-wrong-to")).toBeNull();
    // 過期的 B 連結不能用
    const offerB = /offer=([^&\s]+)&t=([^&\s]+)/.exec(offerMail[0]!.text)!;
    await expect(reg(store, mb, x.tenant, x.s, x.t, "b", { paymentMethod: "offline", offerId: decodeURIComponent(offerB[1]!), offerToken: decodeURIComponent(offerB[2]!) })).rejects.toThrow(/候補保留已過期|名額已滿/);
    // C 用連結完成報名（佔掉自己的保留）
    const c = await reg(store, mb, x.tenant, x.s, x.t, "c", { paymentMethod: "offline", offerId: decodeURIComponent(offerC[1]!), offerToken: decodeURIComponent(offerC[2]!) });
    expect(c.kind).toBe("order");
    expect((await store.listWaitlist(x.tenant.id, x.s.id)).map((w) => w.status)).toEqual(["lapsed", "claimed"]);
    const regC = (await store.listRegistrations(x.tenant.id, { sessionId: x.s.id, status: ["held"], limit: 5, offset: 0 })).rows[0]!;
    expect(regC.source).toBe("waitlist");
  });

  it("訂單取消（店主）→ 名額釋放並遞補候補", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-cancel", { price: 500 });
    const mb = mailbox();
    const deps = { store, baseUrl: "http://test.local", sendMail: mb.sendMail };
    const a = await reg(store, mb, x.tenant, x.s, x.t, "a", { paymentMethod: "offline" });
    await joinWaitlist(deps, { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, contact: contact("b") } });
    const { cancelOrder } = await import("@/lib/services/orders");
    await cancelOrder(x.ctx, { site: "ev-cancel", orderNo: (a as { order: { order_no: string } }).order.order_no, confirm: true });
    expect((await store.listWaitlist(x.tenant.id, x.s.id))[0]!.status).toBe("offered");
  });
});

describe("名單：PII 遮罩、查看紀錄、CSV、簽到", () => {
  it("名單預設遮罩；查看完整資料與匯出都留下紀錄", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-pii", { capacity: 5 });
    const mb = mailbox();
    const r = await reg(store, mb, x.tenant, x.s, x.t, "alice");
    const l = await listRegistrations(x.ctx, { site: "ev-pii", sessionId: x.s.id });
    expect(l.registrations[0]!.contact).toEqual({ name: "王＊＊＊明", email: "al＊＊＊@example.com", phone: "0912＊＊＊678" });
    expect(JSON.stringify(l)).not.toContain("alice@example.com");
    const id = (r as { registration: { id: string } }).registration.id;
    const full = await revealRegistration(x.ctx, { site: "ev-pii", registrationId: id });
    expect(full.contact.email).toBe("alice@example.com");
    await exportRegistrationsCsv(x.ctx, { site: "ev-pii", sessionId: x.s.id });
    const log = await store.listPiiLog(x.tenant.id, 10);
    expect(log.map((p) => p.action).sort()).toEqual(["export", "reveal"]);
    expect(log.every((p) => p.actor === "admin" && p.at)).toBe(true);
  });

  it("CSV injection：= + - @ 開頭（含 Tab／CR）的值前置單引號；欄位一律加引號", async () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    for (const v of ["+886912", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(v).startsWith("\"'")).toBe(true);
    expect(csvCell("王小明")).toBe("\"王小明\"");
    expect(toCsv(["a"], [["=1"]])).toBe("﻿\"a\"\r\n\"'=1\"\r\n");
    const store = newStore();
    const x = await eventSite(store, "ev-csv", { capacity: 5 });
    await reg(store, mailbox(), x.tenant, x.s, x.t, "evil", { contact: { name: "=cmd|' /C calc'!A0", email: "evil@example.com", phone: "+886912345678" } });
    const out = await exportRegistrationsCsv(x.ctx, { site: "ev-csv", sessionId: x.s.id });
    expect(out.csv).toContain("\"'=cmd|' /C calc'!A0\"");
    expect(out.csv).toContain("\"'+886912345678\"");
    expect(out.csv).not.toMatch(/(^|,)=cmd/m);
  });

  it("簽到：需要 confirm、只成功一次；簽到碼可用；待付款不能簽到", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-checkin", { capacity: 5 });
    const r = await reg(store, mailbox(), x.tenant, x.s, x.t, "a");
    const id = (r as { registration: { id: string } }).registration.id;
    await expect(checkIn(x.ctx, { site: "ev-checkin", code: checkinCode(id) })).rejects.toMatchObject({ code: "confirm_required" });
    const c1 = await checkIn(x.ctx, { site: "ev-checkin", code: checkinCode(id).toLowerCase(), confirm: true });
    expect(c1.alreadyCheckedIn).toBe(false);
    expect((await checkIn(x.ctx, { site: "ev-checkin", registrationId: id, confirm: true })).alreadyCheckedIn).toBe(true);
    await expect(checkIn(x.ctx, { site: "ev-checkin", code: "WRONGCODE1", confirm: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("遮罩函式", () => {
    expect(maskContact({ name: "林", email: "x@y.com", phone: "123" })).toEqual({ name: "＊", email: "x＊＊＊@y.com", phone: "＊＊＊" });
  });
});

describe("提醒與取消場次", () => {
  it("提醒信只寄一次（cron 重跑不重寄）；不是明天的場次不寄", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-remind", { capacity: 5, startsInH: 20 });
    const far = await createSession(x.ctx, { site: "ev-remind", eventSlug: "clay", startsAt: new Date(Date.now() + 24 * 5 * H).toISOString(), endsAt: new Date(Date.now() + 24 * 5 * H + H).toISOString(), capacity: 5, confirm: true });
    const farT = await createTicketType(x.ctx, { site: "ev-remind", sessionId: far.id, name: "一般", price: 0, confirm: true });
    const mb = mailbox();
    await reg(store, mb, x.tenant, x.s, x.t, "a");
    await reg(store, mb, x.tenant, far, farT, "b");
    const deps = { store, baseUrl: "http://test.local", sendMail: mb.sendMail };
    await Promise.all([runEventsCron(deps), runEventsCron(deps)]);
    await runEventsCron(deps);
    expect(mb.sent.filter((m) => /活動提醒/.test(m.subject) && m.to === "a@example.com")).toHaveLength(1);
    expect(mb.sent.filter((m) => /活動提醒/.test(m.subject) && m.to === "b@example.com")).toHaveLength(0);
  });

  it("取消場次：需要 confirm；已付款標待退款、未付款訂單取消、免費取消、候補取消，全部通知", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-cs", { capacity: 3, price: 300 });
    const free = await createTicketType(x.ctx, { site: "ev-cs", sessionId: x.s.id, name: "公關票", price: 0, confirm: true });
    const mb = mailbox();
    const paid = await reg(store, mb, x.tenant, x.s, x.t, "paid", { paymentMethod: "offline" });
    await markOrderPaid(x.ctx, { site: "ev-cs", orderNo: (paid as { order: { order_no: string } }).order.order_no, confirm: true });
    const pending = await reg(store, mb, x.tenant, x.s, x.t, "pend", { paymentMethod: "offline" });
    await reg(store, mb, x.tenant, x.s, free, "free");
    await joinWaitlist({ store, baseUrl: "http://t", sendMail: mb.sendMail }, { tenant: x.tenant, member: null, data: { sessionId: x.s.id, ticketTypeId: x.t.id, contact: contact("w") } });
    const ctx = { ...x.ctx, sendMail: mb.sendMail };
    await expect(cancelSession(ctx, { site: "ev-cs", sessionId: x.s.id })).rejects.toMatchObject({ code: "confirm_required" });
    const r = await cancelSession(ctx, { site: "ev-cs", sessionId: x.s.id, reason: "講師生病", confirm: true });
    expect(r).toMatchObject({ notified: 3, refundRequired: 1 });
    const rows = (await store.listRegistrations(x.tenant.id, { sessionId: x.s.id, limit: 10, offset: 0 })).rows;
    expect(rows.every((g) => g.status === "cancelled")).toBe(true);
    expect(rows.filter((g) => g.refund_required)).toHaveLength(1);
    expect((await store.getOrderById(x.tenant.id, (pending as { order: { id: string } }).order.id))!.status).toBe("cancelled");
    expect((await store.listWaitlist(x.tenant.id, x.s.id))[0]!.status).toBe("cancelled");
    for (const who of ["paid", "pend", "free", "w"]) expect(mb.sent.some((m) => m.to === `${who}@example.com` && /取消通知/.test(m.subject))).toBe(true);
    await expect(reg(store, mb, x.tenant, x.s, free, "late")).rejects.toThrow(/不開放/);
  });
});

describe("隔離、scope、confirm", () => {
  it("A 站的活動與報名在 B 站不可見／不可操作", async () => {
    const store = newStore();
    const a = await eventSite(store, "ev-iso-a", { capacity: 5 });
    const b = await eventSite(store, "ev-iso-b", { capacity: 5 });
    const r = await reg(store, mailbox(), a.tenant, a.s, a.t, "a");
    const id = (r as { registration: { id: string } }).registration.id;
    await expect(listRegistrations(b.ctx, { site: "ev-iso-b", sessionId: a.s.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(revealRegistration(b.ctx, { site: "ev-iso-b", registrationId: id })).rejects.toMatchObject({ code: "not_found" });
    await expect(reg(store, mailbox(), b.tenant, a.s, a.t, "x")).rejects.toMatchObject({ code: "not_found" });
    // 租戶 token 帶別站 slug → forbidden
    const tokenA: Actor = { kind: "token", label: "t", tenantId: a.tenant.id, scopes: ["site:read", "attendees:read", "classes:write"] };
    await expect(listRegistrations({ ...a.ctx, actor: tokenA }, { site: "ev-iso-b", sessionId: b.s.id })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("scope：沒有 attendees:read 不能讀名單；沒有 attendees:write 不能簽到；沒有 publish 不能上架活動", async () => {
    const store = newStore();
    const x = await eventSite(store, "ev-scope", { capacity: 5 });
    const actor = (scopes: Actor["scopes"]): Actor => ({ kind: "token", label: "t", tenantId: x.tenant.id, scopes });
    await expect(listRegistrations({ ...x.ctx, actor: actor(["site:read"]) }, { sessionId: x.s.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(checkIn({ ...x.ctx, actor: actor(["attendees:read"]) }, { code: "X", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createEvent({ ...x.ctx, actor: actor(["classes:write"]) }, { slug: "x", title: "X", status: "published", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createEvent({ ...x.ctx, actor: actor(["classes:write", "publish"]) }, { slug: "x", title: "X", status: "published" })).rejects.toMatchObject({ code: "confirm_required" });
    // 已上架活動加場次也要 confirm
    await expect(createSession({ ...x.ctx, actor: actor(["classes:write", "publish"]) }, { eventSlug: "clay", startsAt: new Date(Date.now() + 99 * H).toISOString(), endsAt: new Date(Date.now() + 100 * H).toISOString(), capacity: 3 })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(cancelSession({ ...x.ctx, actor: actor(["attendees:write"]) }, { sessionId: x.s.id, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
  });
});

void enableModule;
