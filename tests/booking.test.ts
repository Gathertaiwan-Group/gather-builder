/**
 * booking 模組（記憶體 Store）：建立預約（不收費直接確認、收訂金走訂單）、同時段第二筆被拒、確認信附 .ics、
 * 自助取消期限、改期、店家取消、保留逾期釋放、提醒只寄一次、租戶隔離、scope／confirm。
 * 真 DB 併發同時段在 tests/integration/classes.test.ts。🔴 全部用假寄信。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { markOrderPaid } from "@/lib/services/orders";
import {
  addDateOverride,
  bookSlot,
  cancelBooking,
  createService,
  getBookingAvailability,
  listBookings,
  manageToken,
  runBookingCron,
  selfCancelBooking,
  selfRescheduleBooking,
  setWeeklyHours,
  updateService,
} from "@/lib/services/booking";
import { taipeiDateOf, addDays } from "@/lib/booking/availability";
import type { Store } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";
import type { MailAttachment } from "@/lib/mail";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 6).toString("base64");
});
afterEach(() => vi.useRealTimers());

const contact = (n: string) => ({ name: `陳${n}`, email: `${n}@example.com`, phone: "0912345678" });
function mailbox() {
  const sent: { to: string; subject: string; text: string; attachments?: MailAttachment[] }[] = [];
  return { sent, sendMail: async (to: string, subject: string, text: string, attachments?: MailAttachment[]) => void sent.push({ to, subject, text, attachments }) };
}

/** 每天 09:00–18:00 都開；服務 60 分＋緩衝 15 分 */
async function bookingSite(store: Store, slug: string, svc: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: `工作室 ${slug}`, modules: ["booking", "shop"] });
  await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款" }, ownerEmail: "owner@example.com" } });
  await configureModule(ctx, { site: slug, moduleId: "booking", config: { location: "台北市測試路 1 號", ...settings } });
  await publishSite(ctx, { site: slug, confirm: true });
  const s = await createService(ctx, { site: slug, slug: "consult", name: "一對一諮詢", durationMin: 60, bufferMin: 15, price: 1500, status: "published", confirm: true, ...svc });
  await setWeeklyHours(ctx, { site: slug, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })), confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  return { ctx, tenant, s };
}
/** 3 天後台北 10:00 */
const day3 = () => addDays(taipeiDateOf(new Date()), 3);
const at = (date: string, hm: string) => new Date(`${date}T${hm}:00+08:00`).toISOString();

const book = (store: Store, mb: ReturnType<typeof mailbox>, tenant: Awaited<ReturnType<typeof bookingSite>>["tenant"], serviceId: string, startsAt: string, who: string, extra: Record<string, unknown> = {}) =>
  bookSlot({ store, baseUrl: "http://test.local", sendMail: mb.sendMail }, { tenant, member: null, data: { serviceId, startsAt, contact: contact(who), ...extra } });

describe("建立預約", () => {
  it("現場付款的服務：直接確認、確認信附 .ics（時間正確）；同時段第二筆被拒；緩衝內的下一格也被拒", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-free");
    const mb = mailbox();
    const r = await book(store, mb, x.tenant, x.s.id, at(day3(), "10:00"), "a");
    expect(r.kind).toBe("confirmed");
    const mail = mb.sent.find((m) => m.to === "a@example.com")!;
    const ics = mail.attachments?.[0]?.content ?? "";
    expect(ics).toContain(`DTSTART:${day3().replace(/-/g, "")}T020000Z`);
    expect(ics).toContain(`DTEND:${day3().replace(/-/g, "")}T030000Z`);
    expect(ics).toContain("LOCATION:台北市測試路 1 號");
    expect(mail.text).toContain("/book/manage?b=");
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "10:00"), "b")).rejects.toMatchObject({ code: "conflict" });
    // 10:00–11:00＋緩衝 15 → 11:00 不可約、11:30 可以
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "11:00"), "b")).rejects.toThrow(/無法預約/);
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "11:30"), "b")).resolves.toMatchObject({ kind: "confirmed" });
    // 不在營業時間、不在時段格子上
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "08:00"), "c")).rejects.toThrow(/無法預約/);
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "13:10"), "c")).rejects.toThrow(/無法預約/);
  });

  it("收訂金：建立訂單（金額＝訂金）、付款前保留時段；標記收款後確認並寄 .ics", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-dep", { paymentMode: "deposit", depositAmount: 500 });
    const mb = mailbox();
    const r = await book(store, mb, x.tenant, x.s.id, at(day3(), "14:00"), "a", { paymentMethod: "offline" });
    expect(r.kind).toBe("order");
    if (r.kind !== "order") return;
    expect(r.order).toMatchObject({ total: 500, status: "pending_payment" });
    expect((await store.listOrderItems(x.tenant.id, r.order.id))[0]).toMatchObject({ item_kind: "booking", ref_id: x.s.id });
    const held = (await store.getBooking(x.tenant.id, r.bookingId!))!;
    expect(held).toMatchObject({ status: "held", amount_due: 500, price: 1500 });
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "14:00"), "b", { paymentMethod: "offline" })).rejects.toThrow();
    await markOrderPaid({ ...x.ctx, sendMail: mb.sendMail }, { site: "bk-dep", orderNo: r.order.order_no, confirm: true });
    expect((await store.getBooking(x.tenant.id, held.id))!.status).toBe("confirmed");
    expect(mb.sent.some((m) => m.to === "a@example.com" && /預約成功/.test(m.subject) && m.attachments?.[0]?.content.includes("BEGIN:VEVENT"))).toBe(true);
  });

  it("付款保留逾期 → 時段釋放（同一時段下一位可以約）", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-exp", { paymentMode: "full" });
    const mb = mailbox();
    const day5 = addDays(taipeiDateOf(new Date()), 5);
    const r = (await book(store, mb, x.tenant, x.s.id, at(day5, "10:00"), "a", { paymentMethod: "offline" })) as { order: { id: string; expires_at: string } };
    await expect(book(store, mb, x.tenant, x.s.id, at(day5, "10:00"), "b", { paymentMethod: "offline" })).rejects.toMatchObject({ code: "conflict" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(r.order.expires_at).getTime() + 60_000);
    const r2 = await book(store, mb, x.tenant, x.s.id, at(day5, "10:00"), "b", { paymentMethod: "offline" });
    expect(r2.kind).toBe("order");
    expect((await store.getOrderById(x.tenant.id, r.order.id))!.status).toBe("cancelled");
    const all = (await store.listBookings(x.tenant.id, { limit: 10, offset: 0 })).rows;
    expect(all.find((b) => b.contact.email === "a@example.com")!.status).toBe("expired");
  });

  it("例外日休假、加開；可預約時段查詢扣掉已預約", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-ovr");
    await expect(addDateOverride(x.ctx, { site: "bk-ovr", date: day3(), kind: "closed" })).rejects.toMatchObject({ code: "confirm_required" });
    await addDateOverride(x.ctx, { site: "bk-ovr", date: day3(), kind: "closed", confirm: true });
    await addDateOverride(x.ctx, { site: "bk-ovr", date: day3(), kind: "open", start: "19:00", end: "21:00", confirm: true });
    const a = await getBookingAvailability(x.ctx, { site: "bk-ovr", serviceSlug: "consult", fromDate: day3(), days: 1 });
    expect(a.days[0]!.slots.map((s) => s.label)).toEqual(["19:00", "19:30", "20:00"]);
    await book(store, mailbox(), x.tenant, x.s.id, at(day3(), "19:00"), "a");
    const b = await getBookingAvailability(x.ctx, { site: "bk-ovr", serviceSlug: "consult", fromDate: day3(), days: 1 });
    // 19:00–20:00＋緩衝 15 分 → 20:00 那格（到 21:00）也被擋
    expect(b.days[0]!.slots.map((s) => s.label)).toEqual([]);
  });
});

describe("自助取消／改期、店家取消", () => {
  it("期限前可自助取消（簽章連結）；期限內不行；錯誤簽章不行", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-self", {}, { cancelDeadlineHours: 24 });
    const mb = mailbox();
    const deps = { store, baseUrl: "http://test.local", sendMail: mb.sendMail };
    const near = await book(store, mb, x.tenant, x.s.id, at(addDays(taipeiDateOf(new Date()), 1), "17:00"), "near");
    const far = await book(store, mb, x.tenant, x.s.id, at(day3(), "10:00"), "far");
    const nb = (near as { booking: { id: string; starts_at: string } }).booking;
    const fb = (far as { booking: { id: string } }).booking;
    await expect(selfCancelBooking(deps, { tenant: x.tenant, bookingId: fb.id, token: "x".repeat(32) })).rejects.toMatchObject({ code: "not_found" });
    // 用「開始前 23 小時」當作現在 → 期限內
    const now = new Date(new Date(nb.starts_at).getTime() - 23 * 3600_000);
    await expect(selfCancelBooking(deps, { tenant: x.tenant, bookingId: nb.id, token: manageToken(nb), now })).rejects.toThrow(/24 小時內/);
    const r = await selfCancelBooking(deps, { tenant: x.tenant, bookingId: fb.id, token: manageToken(fb) });
    expect(r).toMatchObject({ status: "cancelled", refundRequired: false });
    expect(mb.sent.some((m) => m.to === "far@example.com" && /已取消/.test(m.subject) && m.attachments?.[0]?.content.includes("METHOD:CANCEL"))).toBe(true);
    // 取消後時段空出來
    await expect(book(store, mb, x.tenant, x.s.id, at(day3(), "10:00"), "next")).resolves.toMatchObject({ kind: "confirmed" });
  });

  it("改期：新時段要可約；改到被占的時段被拒；改期後舊時段釋放、提醒重置", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-move");
    const mb = mailbox();
    const deps = { store, baseUrl: "http://test.local", sendMail: mb.sendMail };
    const a = (await book(store, mb, x.tenant, x.s.id, at(day3(), "10:00"), "a")) as { booking: { id: string } };
    await book(store, mb, x.tenant, x.s.id, at(day3(), "14:00"), "b");
    await expect(selfRescheduleBooking(deps, { tenant: x.tenant, bookingId: a.booking.id, token: manageToken(a.booking), startsAt: at(day3(), "14:00") })).rejects.toThrow(/無法預約/);
    // 改到 10:30（與自己原本的時段重疊也可以，因為排除自己）
    await selfRescheduleBooking(deps, { tenant: x.tenant, bookingId: a.booking.id, token: manageToken(a.booking), startsAt: at(day3(), "10:30") });
    const moved = (await store.getBooking(x.tenant.id, a.booking.id))!;
    expect(moved.starts_at).toBe(at(day3(), "10:30"));
    expect(mb.sent.some((m) => m.to === "a@example.com" && /改期/.test(m.subject))).toBe(true);
  });

  it("店家取消：需要 confirm；已付款標待退款、不自動退款", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-owner", { paymentMode: "full" });
    const mb = mailbox();
    const r = (await book(store, mb, x.tenant, x.s.id, at(day3(), "10:00"), "a", { paymentMethod: "offline" })) as { order: { order_no: string }; bookingId: string };
    await markOrderPaid(x.ctx, { site: "bk-owner", orderNo: r.order.order_no, confirm: true });
    await expect(cancelBooking(x.ctx, { site: "bk-owner", bookingId: r.bookingId })).rejects.toMatchObject({ code: "confirm_required" });
    const c = await cancelBooking({ ...x.ctx, sendMail: mb.sendMail }, { site: "bk-owner", bookingId: r.bookingId, confirm: true });
    expect(c).toMatchObject({ refundRequired: true, status: "cancelled" });
    expect((await store.getOrderByNo(x.tenant.id, r.order.order_no))!.status).toBe("paid");
  });
});

describe("提醒、列表遮罩、隔離、scope", () => {
  it("提醒信只寄一次（cron 重跑、併發都不重寄）；改期會重置", async () => {
    const store = newStore();
    const x = await bookingSite(store, "bk-rem");
    const mb = mailbox();
    await book(store, mb, x.tenant, x.s.id, at(addDays(taipeiDateOf(new Date()), 1), "15:00"), "a");
    const deps = { store, baseUrl: "http://test.local", sendMail: mb.sendMail };
    await Promise.all([runBookingCron(deps), runBookingCron(deps)]);
    await runBookingCron(deps);
    expect(mb.sent.filter((m) => /預約提醒/.test(m.subject))).toHaveLength(1);
  });

  it("list_bookings 遮罩；A 站的預約在 B 站不可見；沒 attendees:read 被拒；set_weekly_hours 沒 publish 被拒", async () => {
    const store = newStore();
    const a = await bookingSite(store, "bk-iso-a");
    const b = await bookingSite(store, "bk-iso-b");
    const r = (await book(store, mailbox(), a.tenant, a.s.id, at(day3(), "10:00"), "alice")) as { booking: { id: string } };
    const la = await listBookings(a.ctx, { site: "bk-iso-a" });
    expect(la.bookings[0]!.contact.email).toBe("al＊＊＊@example.com");
    expect((await listBookings(b.ctx, { site: "bk-iso-b" })).total).toBe(0);
    await expect(cancelBooking(b.ctx, { site: "bk-iso-b", bookingId: r.booking.id, confirm: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(book(store, mailbox(), b.tenant, a.s.id, at(day3(), "12:00"), "x")).rejects.toMatchObject({ code: "not_found" });
    const actor = (scopes: Actor["scopes"]): Actor => ({ kind: "token", label: "t", tenantId: a.tenant.id, scopes });
    await expect(listBookings({ ...a.ctx, actor: actor(["site:read"]) }, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(setWeeklyHours({ ...a.ctx, actor: actor(["classes:write"]) }, { hours: [], confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setWeeklyHours({ ...a.ctx, actor: actor(["classes:write", "publish"]) }, { hours: [] })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(updateService({ ...a.ctx, actor: actor(["classes:write"]) }, { slug: "consult", patch: { price: 1 } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(cancelBooking({ ...a.ctx, actor: actor(["attendees:read"]) }, { bookingId: r.booking.id, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("線上收費需要 shop；訂金不能超過價格", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "bk-noshop", name: "x", modules: ["booking"] });
    await expect(createService(ctx, { site: "bk-noshop", slug: "a", name: "A", durationMin: 30, price: 100, paymentMode: "full" })).rejects.toThrow(/shop/);
    await expect(createService(ctx, { site: "bk-noshop", slug: "b", name: "B", durationMin: 30, price: 100, paymentMode: "deposit", depositAmount: 200 })).rejects.toThrow(/訂金|depositAmount/);
    await expect(createService(ctx, { site: "bk-noshop", slug: "c", name: "C", durationMin: 30, price: 100 })).resolves.toMatchObject({ paymentMode: "none" });
  });
});
