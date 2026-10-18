import { z } from "zod";
import { PROVIDER_IDS } from "../pay/types";
import { RESERVE_ERRORS } from "../store/reserve-errors";
import type { EventRow, EventSessionRow, MemberRow, OrderRow, RegistrationRow, RegistrationStatus, Store, TenantRow, TicketTypeRow, WaitlistRow } from "../store/types";
import type { EventsSettings } from "@/modules/events/manifest";
import { imageUrl, optText, postSlug, safeHref, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, publishedShopSettings, twd, type CheckoutDeps } from "./shop";
import { registerOrderHooks, type CancelDeps, type HookDeps } from "./order-hooks";
import { cancelOrderWithHooks, expireIfDue } from "./orders";
import { getMailer } from "../mail";
import {
  checkinCode,
  checkinHash,
  fmtTaipei,
  maskContact,
  placeClassOrder,
  shopActive,
  signFor,
  toCsv,
  verifySigned,
  taipeiDate,
  taipeiAt,
} from "./class-orders";
import { classContactInput } from "./class-common";
import { normalizeEmail } from "../email-normalize";

/* ================================================================== 共用 */

export async function eventsActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("events");
}
async function requireEvents(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await eventsActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「events」，請先 enable_module events");
}
export async function eventsSettingsFor(store: Store, tenant: TenantRow): Promise<EventsSettings> {
  return (await publishedModuleSettings(store, tenant, "events")) as EventsSettings;
}
const DEFAULT_OFFER_HOURS = 24;

/** 會直接改變線上內容（已上架活動／新增場次票種／上架）→ 與 publish_site 同一道門檻 */
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請把活動維持 draft，再請有權限的人上架。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}
function requireConfirm(confirm: boolean | undefined, what: string) {
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

const isoInput = z.iso.datetime({ offset: true, message: "時間請用 ISO 8601 並帶時區，例如 2026-11-01T14:00:00+08:00" });

export const eventInput = z
  .object({
    slug: postSlug.refine((v) => v !== "confirm", { message: "slug「confirm」保留給報名確認頁" }),
    title: text(160),
    summary: optText(300),
    bodyMd: z.string().max(50_000).default(""),
    coverUrl: imageUrl.optional(),
    locationType: z.enum(["physical", "online", "hybrid"]).default("physical"),
    location: optText(300),
    /** 線上活動連結：只寄給已確認的報名者，不出現在公開頁 */
    onlineUrl: safeHref.optional(),
    status: z.enum(["draft", "published"]).default("draft"),
    sort: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

function eventSummary(e: EventRow) {
  return { id: e.id, slug: e.slug, title: e.title, status: e.status, locationType: e.location_type, location: e.location, summary: e.summary, coverUrl: e.cover_url, hasOnlineUrl: !!e.online_url, sort: e.sort };
}

async function findEvent(ctx: ServiceContext, tenant: TenantRow, ref: { eventId?: string; slug?: string; eventSlug?: string }) {
  const slug = ref.slug ?? ref.eventSlug;
  const e = ref.eventId ? await ctx.store.getEventById(tenant.id, ref.eventId) : slug ? await ctx.store.getEventBySlug(tenant.id, slug) : null;
  if (!e) throw new ServiceError("not_found", "找不到活動（請給 eventId 或 slug）");
  return e;
}

/* ================================================================== 活動／場次／票種（MCP＋後台） */

export async function createEvent(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof eventInput>) {
  requireScope(ctx, "classes:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireEvents(ctx, tenant);
  const d = parse(eventInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架活動", confirm);
  if (await ctx.store.getEventBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `活動 slug「${d.slug}」已存在`);
  const row = await ctx.store.insertEvent({
    tenant_id: tenant.id,
    slug: d.slug,
    title: d.title,
    summary: d.summary ?? null,
    body_md: d.bodyMd,
    cover_url: d.coverUrl ?? null,
    location_type: d.locationType,
    location: d.location ?? null,
    online_url: d.onlineUrl ?? null,
    status: d.status,
    sort: d.sort,
  });
  await audit(ctx, tenant.id, "event.create", { eventId: row.id, slug: row.slug, status: row.status });
  return { ...eventSummary(row), note: row.status === "published" ? "活動已上架。接著用 create_session 加場次、create_ticket_type 加票種。" : "活動為草稿：先 create_session／create_ticket_type，再用 update_event { status: \"published\" } 上架。" };
}

export async function updateEvent(ctx: ServiceContext, input: { site?: string | null; eventId?: string; slug?: string; confirm?: boolean; patch: Partial<z.input<typeof eventInput>> }) {
  requireScope(ctx, "classes:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const e = await findEvent(ctx, tenant, input);
  const given = input.patch ?? {};
  const p = parse(eventInput.partial().strict(), given);
  const next = given.status ?? e.status;
  if (e.status === "published" || next === "published") requireLiveConfirm(ctx, "修改／上架／下架已上架的活動", input.confirm);
  if (p.slug && p.slug !== e.slug && (await ctx.store.getEventBySlug(tenant.id, p.slug))) throw new ServiceError("conflict", `活動 slug「${p.slug}」已存在`);
  const patch: Parameters<Store["updateEvent"]>[2] = {};
  if (given.slug !== undefined) patch.slug = p.slug;
  if (given.title !== undefined) patch.title = p.title;
  if (given.summary !== undefined) patch.summary = p.summary ?? null;
  if (given.bodyMd !== undefined) patch.body_md = p.bodyMd;
  if (given.coverUrl !== undefined) patch.cover_url = p.coverUrl ?? null;
  if (given.locationType !== undefined) patch.location_type = p.locationType;
  if (given.location !== undefined) patch.location = p.location ?? null;
  if (given.onlineUrl !== undefined) patch.online_url = p.onlineUrl ?? null;
  if (given.status !== undefined) patch.status = p.status;
  if (given.sort !== undefined) patch.sort = p.sort;
  const row = (await ctx.store.updateEvent(tenant.id, e.id, patch))!;
  await audit(ctx, tenant.id, "event.update", { eventId: e.id, keys: Object.keys(given) });
  return eventSummary(row);
}

export const sessionInput = z
  .object({
    startsAt: isoInput,
    endsAt: isoInput,
    capacity: z.number().int().min(1).max(100000),
    /** 店主手動保留／線下已售的座位（計入名額） */
    offlineSeats: z.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), { message: "結束時間要晚於開始時間", path: ["endsAt"] });

export async function createSession(ctx: ServiceContext, input: { site?: string | null; eventId?: string; eventSlug?: string; confirm?: boolean } & z.input<typeof sessionInput>) {
  requireScope(ctx, "classes:write");
  const { site, eventId, eventSlug, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireEvents(ctx, tenant);
  const e = await findEvent(ctx, tenant, { eventId, eventSlug });
  const d = parse(sessionInput, rest);
  if (new Date(d.startsAt).getTime() <= Date.now()) throw new ServiceError("invalid", "場次開始時間必須在未來");
  if (d.offlineSeats > d.capacity) throw new ServiceError("invalid", "保留座位不能超過容量");
  if (e.status === "published") requireLiveConfirm(ctx, "為已上架的活動新增場次", confirm);
  const row = await ctx.store.insertSession({ tenant_id: tenant.id, event_id: e.id, starts_at: new Date(d.startsAt).toISOString(), ends_at: new Date(d.endsAt).toISOString(), timezone: "Asia/Taipei", capacity: d.capacity, offline_seats: d.offlineSeats });
  await audit(ctx, tenant.id, "event.session.create", { eventId: e.id, sessionId: row.id });
  return { ...sessionSummary(row), note: "場次已建立，請用 create_ticket_type 為這個場次加票種（價格 0＝免費）。" };
}

export const ticketInput = z
  .object({
    name: text(80),
    price: z.number().int().min(0).max(1_000_000),
    maxPerOrder: z.number().int().min(1).max(20).default(4),
    salesStart: isoInput.optional(),
    salesEnd: isoInput.optional(),
    quota: z.number().int().min(1).max(100000).optional(),
    sort: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict();

export async function createTicketType(ctx: ServiceContext, input: { site?: string | null; sessionId: string; confirm?: boolean } & z.input<typeof ticketInput>) {
  requireScope(ctx, "classes:write");
  const { site, sessionId, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireEvents(ctx, tenant);
  const s = await ctx.store.getSession(tenant.id, sessionId);
  if (!s) throw new ServiceError("not_found", "找不到場次");
  const e = (await ctx.store.getEventById(tenant.id, s.event_id))!;
  const d = parse(ticketInput, rest);
  if (d.salesStart && d.salesEnd && new Date(d.salesEnd) <= new Date(d.salesStart)) throw new ServiceError("invalid", "販售結束要晚於開始");
  if (d.price > 0 && !(await shopActive(ctx.store, tenant.id))) throw new ServiceError("invalid", "付費票需要先啟用 shop 模組（線下匯款或 PChomePay）：enable_module shop");
  if (e.status === "published") requireLiveConfirm(ctx, "為已上架的活動新增票種", confirm);
  const row = await ctx.store.insertTicketType({
    tenant_id: tenant.id,
    event_id: e.id,
    session_id: s.id,
    name: d.name,
    price: d.price,
    max_per_order: d.maxPerOrder,
    sales_start: d.salesStart ? new Date(d.salesStart).toISOString() : null,
    sales_end: d.salesEnd ? new Date(d.salesEnd).toISOString() : null,
    quota: d.quota ?? null,
    active: true,
    sort: d.sort,
  });
  await audit(ctx, tenant.id, "event.ticket.create", { sessionId: s.id, ticketTypeId: row.id, price: row.price });
  return ticketSummary(row);
}

function sessionSummary(s: EventSessionRow) {
  return { id: s.id, eventId: s.event_id, startsAt: s.starts_at, endsAt: s.ends_at, startsAtTaipei: fmtTaipei(s.starts_at), capacity: s.capacity, offlineSeats: s.offline_seats, status: s.status };
}
function ticketSummary(t: TicketTypeRow) {
  return { id: t.id, sessionId: t.session_id, name: t.name, price: t.price, maxPerOrder: t.max_per_order, salesStart: t.sales_start, salesEnd: t.sales_end, quota: t.quota, active: t.active };
}

/** 場次的即時名額（由報名列加總；不是計數欄位） */
export async function sessionAvailability(store: Store, s: EventSessionRow) {
  const u = await store.sessionUsage(s.tenant_id, s.id);
  const remaining = Math.max(0, s.capacity - s.offline_seats - u.taken - u.offered);
  return { ...u, remaining };
}

export async function listEvents(ctx: ServiceContext, input: { site?: string | null; status?: "draft" | "published" | "cancelled"; limit?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const r = await ctx.store.listEvents(tenant.id, { status: input.status, limit: Math.max(1, Math.min(50, input.limit ?? 20)), offset: 0 });
  const sessions = await ctx.store.listSessions(tenant.id, r.rows.map((e) => e.id));
  const tickets = await ctx.store.listTicketTypes(tenant.id, sessions.map((s) => s.id));
  const avail = await Promise.all(sessions.map((s) => sessionAvailability(ctx.store, s)));
  return {
    total: r.total,
    events: r.rows.map((e) => ({
      ...eventSummary(e),
      sessions: sessions
        .map((s, i) => ({ s, a: avail[i]! }))
        .filter((x) => x.s.event_id === e.id)
        .map(({ s, a }) => ({ ...sessionSummary(s), registered: a.taken, offered: a.offered, waiting: a.waiting, remaining: a.remaining, tickets: tickets.filter((t) => t.session_id === s.id).map(ticketSummary) })),
    })),
  };
}

/* ================================================================== 名單（個資遮罩、查看紀錄、CSV、簽到） */

function regSummary(r: RegistrationRow, t: TicketTypeRow | undefined, reveal: boolean) {
  return {
    id: r.id,
    sessionId: r.session_id,
    ticket: t?.name ?? null,
    qty: r.qty,
    unitPrice: r.unit_price,
    status: r.status,
    source: r.source,
    contact: reveal ? r.contact : maskContact(r.contact),
    orderId: r.order_id,
    memberId: r.member_id,
    checkedInAt: r.checked_in_at,
    refundRequired: r.refund_required,
    createdAt: r.created_at,
  };
}

async function regsFor(ctx: ServiceContext, tenant: TenantRow, input: { eventId?: string; eventSlug?: string; sessionId?: string; status?: RegistrationStatus[] }) {
  let sessionId = input.sessionId;
  let eventId: string | undefined;
  if (!sessionId) eventId = (await findEvent(ctx, tenant, { eventId: input.eventId, eventSlug: input.eventSlug })).id;
  else if (!(await ctx.store.getSession(tenant.id, sessionId))) throw new ServiceError("not_found", "找不到場次");
  // 先 lazy 處理這個場次已逾期的保留（線上付款單會先權威回查），名單才是真的
  if (sessionId) await releaseExpiredSessionHolds({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, sessionId);
  const r = await ctx.store.listRegistrations(tenant.id, { sessionId, eventId, status: input.status, limit: 2000, offset: 0 });
  const tickets = await ctx.store.listTicketTypes(tenant.id, [...new Set(r.rows.map((x) => x.session_id))]);
  return { rows: r.rows, tickets };
}

/** 名單（個資遮罩）。需要 attendees:read。 */
export async function listRegistrations(ctx: ServiceContext, input: { site?: string | null; eventId?: string; eventSlug?: string; sessionId?: string; status?: RegistrationStatus[] }) {
  requireScope(ctx, "attendees:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const { rows, tickets } = await regsFor(ctx, tenant, input);
  const live = rows.filter((r) => r.status === "held" || r.status === "confirmed");
  return {
    total: rows.length,
    confirmedSeats: rows.filter((r) => r.status === "confirmed").reduce((n, r) => n + r.qty, 0),
    heldSeats: rows.filter((r) => r.status === "held").reduce((n, r) => n + r.qty, 0),
    checkedIn: live.filter((r) => r.checked_in_at).length,
    registrations: rows.map((r) => regSummary(r, tickets.find((t) => t.id === r.ticket_type_id), false)),
    note: "聯絡資料已遮罩。查看完整資料或匯出 CSV 請到平台後台（會留下查看紀錄）。",
  };
}

/** 查看單筆完整聯絡資料：記錄 who/when（builder_pii_access_log＋稽核） */
export async function revealRegistration(ctx: ServiceContext, input: { site?: string | null; registrationId: string; reason?: string }) {
  requireScope(ctx, "attendees:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const r = await ctx.store.getRegistration(tenant.id, input.registrationId);
  if (!r) throw new ServiceError("not_found", "找不到報名");
  await ctx.store.insertPiiLog({ tenant_id: tenant.id, actor: ctx.actor.label, action: "reveal", subject_type: "event_registration", subject_id: r.id, detail: { reason: input.reason?.slice(0, 200) ?? null } });
  await audit(ctx, tenant.id, "pii.reveal", { registrationId: r.id });
  const t = await ctx.store.getTicketType(tenant.id, r.ticket_type_id);
  return regSummary(r, t ?? undefined, true);
}

/** 名單 CSV（明文；匯出前先記錄 who/when）。🔴 每個儲存格防 CSV injection（csvCell） */
export async function exportRegistrationsCsv(ctx: ServiceContext, input: { site?: string | null; sessionId: string }) {
  requireScope(ctx, "attendees:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const s = await ctx.store.getSession(tenant.id, input.sessionId);
  if (!s) throw new ServiceError("not_found", "找不到場次");
  const e = (await ctx.store.getEventById(tenant.id, s.event_id))!;
  const { rows, tickets } = await regsFor(ctx, tenant, { sessionId: s.id });
  const live = rows.filter((r) => r.status === "held" || r.status === "confirmed");
  await ctx.store.insertPiiLog({ tenant_id: tenant.id, actor: ctx.actor.label, action: "export", subject_type: "event_session", subject_id: s.id, detail: { rows: live.length } });
  await audit(ctx, tenant.id, "pii.export", { sessionId: s.id, rows: live.length });
  const orders = new Map<string, OrderRow>();
  for (const r of live) if (r.order_id && !orders.has(r.order_id)) {
    const o = await ctx.store.getOrderById(tenant.id, r.order_id);
    if (o) orders.set(o.id, o);
  }
  const STATUS: Record<string, string> = { held: "保留中（待付款）", confirmed: "已確認" };
  const csv = toCsv(
    ["活動", "場次開始", "票種", "張數", "姓名", "Email", "電話", "狀態", "訂單編號", "已付款", "簽到時間", "報名時間"],
    live.map((r) => {
      const o = r.order_id ? orders.get(r.order_id) : undefined;
      return [e.title, fmtTaipei(s.starts_at, false), tickets.find((t) => t.id === r.ticket_type_id)?.name ?? "", r.qty, r.contact.name, r.contact.email, r.contact.phone, STATUS[r.status] ?? r.status, o?.order_no ?? "", o ? (o.status === "paid" || o.status === "fulfilled" ? "是" : "否") : "免費", r.checked_in_at ? fmtTaipei(r.checked_in_at, false) : "", fmtTaipei(r.created_at, false)];
    }),
  );
  return { filename: `roster-${e.slug}-${taipeiDate(new Date(s.starts_at))}.csv`, csv, rows: live.length };
}

/** 簽到：報名 id 或簽到碼（confirm）。只有「已確認」的報名能簽到，條件式更新只會成功一次 */
export async function checkIn(ctx: ServiceContext, input: { site?: string | null; registrationId?: string; code?: string; confirm?: boolean }) {
  requireScope(ctx, "attendees:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const r = input.registrationId
    ? await ctx.store.getRegistration(tenant.id, input.registrationId)
    : input.code
      ? await ctx.store.getRegistrationByCheckinHash(tenant.id, checkinHash(input.code))
      : null;
  if (!r) throw new ServiceError("not_found", "找不到報名（請給 registrationId 或簽到碼）");
  if (r.status !== "confirmed") throw new ServiceError("conflict", r.status === "held" ? "這筆報名尚未付款，不能簽到" : "這筆報名已取消");
  if (r.checked_in_at) return { ...regSummary(r, undefined, false), alreadyCheckedIn: true, note: `已在 ${fmtTaipei(r.checked_in_at)} 簽到過` };
  requireConfirm(input.confirm, `為 ${maskContact(r.contact).name}（${r.qty} 位）簽到`);
  const moved = await ctx.store.updateRegistration(tenant.id, r.id, ["confirmed"], { checked_in_at: new Date().toISOString(), checked_in_by: ctx.actor.label }, { requireNull: ["checked_in_at"] });
  if (!moved) throw new ServiceError("conflict", "簽到狀態已被其他操作改變，請重新讀取");
  await audit(ctx, tenant.id, "event.checkin", { registrationId: r.id });
  return { ...regSummary(moved, undefined, false), alreadyCheckedIn: false };
}

/**
 * 取消場次（confirm）：場次 → cancelled；免費報名 → 取消；未付款保留 → 取消訂單（同交易釋放名額）；
 * 已付款 → 報名取消並標「待退款」（不自動退款，提示人工退款）；候補 → 取消。通知所有報名者與候補者。
 */
export async function cancelSession(ctx: ServiceContext, input: { site?: string | null; sessionId: string; reason?: string; confirm?: boolean }) {
  requireScope(ctx, "classes:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireEvents(ctx, tenant);
  const s = await ctx.store.getSession(tenant.id, input.sessionId);
  if (!s) throw new ServiceError("not_found", "找不到場次");
  if (s.status === "cancelled") throw new ServiceError("conflict", "這個場次已經取消了");
  const e = (await ctx.store.getEventById(tenant.id, s.event_id))!;
  const before = (await ctx.store.listRegistrations(tenant.id, { sessionId: s.id, status: ["held", "confirmed"], limit: 5000, offset: 0 })).rows;
  const paidBefore = before.filter((r) => r.status === "confirmed" && r.order_id).length;
  requireConfirm(input.confirm, `取消「${e.title}」${fmtTaipei(s.starts_at)} 場次會通知 ${before.length} 筆報名${paidBefore ? `，其中 ${paidBefore} 筆已付款需人工退款` : ""}，無法復原`);
  const reason = input.reason?.trim().slice(0, 200) || "主辦單位取消場次";
  // L4：先把場次標 cancelled（SQL 報名函式鎖場次後會擋 status<>'scheduled'），再列報名——之後不會再有新報名漏掉
  await ctx.store.updateSession(tenant.id, s.id, { status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: reason });
  const regs = (await ctx.store.listRegistrations(tenant.id, { sessionId: s.id, status: ["held", "confirmed"], limit: 5000, offset: 0 })).rows;
  let refunds = 0;
  for (const r of regs) {
    const o = r.order_id ? await ctx.store.getOrderById(tenant.id, r.order_id) : null;
    if (o && o.status === "pending_payment") {
      await cancelOrderWithHooks({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, o.id, ["pending_payment"], "session_cancelled");
    } else {
      const needsRefund = !!o && (o.status === "paid" || o.status === "fulfilled") && !o.payment_sandbox;
      if (needsRefund) refunds++;
      await ctx.store.updateRegistration(tenant.id, r.id, ["held", "confirmed"], { status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: "session_cancelled", refund_required: needsRefund });
    }
    await mailSafe(
      ctx,
      r.contact.email,
      `【${tenant.name}】活動場次取消通知：${e.title}`,
      `${r.contact.name} 你好，\n\n很抱歉，「${e.title}」${fmtTaipei(s.starts_at)} 的場次已取消。\n原因：${reason}\n${o && (o.status === "paid" || o.status === "fulfilled") ? `你已付款（訂單 ${o.order_no}），店家會與你聯繫退款。` : o ? "你的報名保留已取消，不需要付款。" : ""}\n\n造成不便，敬請見諒。`,
    );
  }
  for (const w of await ctx.store.listWaitlist(tenant.id, s.id)) {
    if (!(await ctx.store.updateWaitlist(tenant.id, w.id, ["waiting", "offered"], { status: "cancelled" }))) continue;
    await mailSafe(ctx, w.contact.email, `【${tenant.name}】活動場次取消通知：${e.title}`, `${w.contact.name} 你好，\n\n「${e.title}」${fmtTaipei(s.starts_at)} 的場次已取消，你的候補登記也一併取消。`);
  }
  await audit(ctx, tenant.id, "event.session.cancel", { sessionId: s.id, registrations: regs.length, refunds });
  return { sessionId: s.id, status: "cancelled", notified: regs.length, refundRequired: refunds, note: refunds ? `有 ${refunds} 筆已付款報名需要人工退款（線上付款請到 PChomePay 商家後台；線下匯款請自行退款），退款後可用 cancel_order 取消訂單。` : "場次已取消並通知報名者。" };
}

/* ================================================================== 前台 */

export interface PublicEvent {
  event: EventRow;
  sessions: (EventSessionRow & { remaining: number; waiting: number; tickets: TicketTypeRow[] })[];
}

/** 前台活動（已上架；只列未來、未取消的場次） */
export async function publicEventView(store: Store, tenant: TenantRow, event: EventRow): Promise<PublicEvent> {
  const sessions = (await store.listSessions(tenant.id, [event.id])).filter((s) => s.status === "scheduled" && new Date(s.starts_at).getTime() > Date.now());
  const tickets = await store.listTicketTypes(tenant.id, sessions.map((s) => s.id));
  const out = await Promise.all(
    sessions.map(async (s) => {
      const a = await sessionAvailability(store, s);
      return { ...s, remaining: a.remaining, waiting: a.waiting, tickets: tickets.filter((t) => t.session_id === s.id && t.active) };
    }),
  );
  return { event, sessions: out };
}

export async function publicEvents(store: Store, tenant: TenantRow, limit: number): Promise<PublicEvent[]> {
  const r = await store.listEvents(tenant.id, { status: "published", limit: 60, offset: 0 });
  const views = await Promise.all(r.rows.map((e) => publicEventView(store, tenant, e)));
  return views
    .filter((v) => v.sessions.length > 0)
    .sort((a, b) => a.sessions[0]!.starts_at.localeCompare(b.sessions[0]!.starts_at))
    .slice(0, limit);
}

export const registerInput = z
  .object({
    sessionId: z.string().trim().min(1).max(64),
    ticketTypeId: z.string().trim().min(1).max(64),
    qty: z.coerce.number().int().min(1).max(20),
    contact: classContactInput,
    paymentMethod: z.enum(["offline", ...PROVIDER_IDS]).optional(),
    couponCode: z.string().trim().max(32).optional(),
    referralCode: z.string().trim().max(16).optional(),
    note: optText(500),
    /** 候補遞補：保留 id＋簽章（信件連結裡的 offer／t） */
    offerId: z.string().trim().max(64).optional(),
    offerToken: z.string().trim().max(64).optional(),
  })
  .strict();

/** 下單／報名前：釋放這個場次已逾期的保留（線上付款單先權威回查，見 expireIfDue），釋放後通知候補 */
export async function releaseExpiredSessionHolds(deps: CheckoutDeps, tenant: TenantRow, sessionId: string) {
  const due = await deps.store.listExpiredHeldOrderIdsForSession(tenant.id, sessionId, new Date().toISOString());
  for (const id of due) {
    const o = await deps.store.getOrderById(tenant.id, id);
    if (o) await expireIfDue(deps.store, o, Date.now(), deps);
  }
  return due.length;
}

/** 免費報名／候補 email 確認期限（分鐘） */
export const EMAIL_CONFIRM_MINUTES = 30;
/** 審查 M6：未確認 email 的免費報名保留時間（佔名額，所以比候補確認更短） */
export const PENDING_HOLD_MINUTES = 15;
/** 審查 M6：每場次未確認保留最多佔容量的比例（%） */
export const DEFAULT_UNCONFIRMED_HOLD_PERCENT = 20;

/** email 確認連結：kind r＝報名、w＝候補；簽章 HMAC(PREVIEW_SECRET, event-confirm-<kind>:id)，不存原文 */
export function confirmUrl(baseUrl: string, tenant: TenantRow, kind: "r" | "w", id: string) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/events/confirm?${kind}=${encodeURIComponent(id)}&t=${encodeURIComponent(signFor(`event-confirm-${kind}`, id))}`;
}

/**
 * 點 email 確認連結（POST，確認頁按鈕送出）：
 * - 報名：仍是 held、沒有訂單、未逾期 → confirmed（寫簽到碼）→ 寄報名成功信。
 * - 候補：仍是 unconfirmed、未逾期 → waiting → 立即嘗試遞補。
 * 逾期或簽章不符一律回同一句。
 */
export async function confirmEventEmail(deps: CheckoutDeps, input: { tenant: TenantRow; kind: unknown; id: unknown; token: unknown }) {
  const { tenant } = input;
  const kind = input.kind === "w" ? "w" : input.kind === "r" ? "r" : null;
  const id = typeof input.id === "string" ? input.id : "";
  const bad = new ServiceError("invalid", "確認連結無效或已過期，請重新報名／登記候補");
  if (!kind || !id || !verifySigned(`event-confirm-${kind}`, id, input.token)) throw bad;
  if (kind === "r") {
    const r = await deps.store.getRegistration(tenant.id, id);
    if (r?.status === "confirmed") return { kind: "registration" as const, already: true, registration: r };
    if (!r || r.status !== "held" || r.order_id || !r.hold_expires_at || new Date(r.hold_expires_at).getTime() <= Date.now()) throw bad;
    const moved = await deps.store.updateRegistration(tenant.id, r.id, ["held"], { status: "confirmed", checkin_code_hash: checkinHash(checkinCode(r.id)), hold_expires_at: null, email_confirmed_at: new Date().toISOString() });
    if (!moved) throw bad;
    const [s, t, e] = await Promise.all([deps.store.getSession(tenant.id, r.session_id), deps.store.getTicketType(tenant.id, r.ticket_type_id), deps.store.getEventById(tenant.id, r.event_id)]);
    if (s && t && e) await sendConfirmedMail(deps, tenant, e, s, t, moved);
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "guest", action: "event.register_confirm", payload: { registrationId: r.id } });
    return { kind: "registration" as const, already: false, registration: moved };
  }
  const w = await deps.store.getWaitlist(tenant.id, id);
  if (w && w.status !== "unconfirmed" && w.status !== "cancelled" && w.status !== "lapsed") return { kind: "waitlist" as const, already: true };
  if (!w || w.status !== "unconfirmed" || !w.confirm_expires_at || new Date(w.confirm_expires_at).getTime() <= Date.now()) throw bad;
  if (!(await deps.store.updateWaitlist(tenant.id, w.id, ["unconfirmed"], { status: "waiting" }))) throw bad;
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "guest", action: "event.waitlist_confirm", payload: { waitlistId: w.id } });
  await promoteWaitlist(deps, tenant, w.session_id);
  return { kind: "waitlist" as const, already: false };
}

export type RegisterResult =
  | { kind: "free"; registration: RegistrationRow; checkinCode: string }
  | { kind: "pending"; registration: RegistrationRow }
  /** 審查 M6：待確認保留已達上限 → 改登記候補（不佔名額，要 email 確認） */
  | { kind: "waitlisted"; waitlistId: string }
  | { kind: "order"; order: OrderRow; accessKey: string; orderUrl: string; registrationId: string | null };

/**
 * 報名（公開）。免費票：原子扣名額後直接成立（寄確認信＋簽到碼）。付費票：建立訂單（同一交易保留名額），付款後才確認。
 * 名額判斷在 DB 交易內（鎖場次列），併發搶最後一席只會成功一筆。
 */
export async function registerEvent(deps: CheckoutDeps, input: { tenant: TenantRow; member: MemberRow | null; data: unknown; allowSandbox?: boolean }): Promise<RegisterResult> {
  const { tenant, member } = input;
  if (!(await eventsActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放活動報名");
  const settings = await eventsSettingsFor(deps.store, tenant);
  if (settings.allowGuest === false && !member) throw new ServiceError("unauthorized", "請先登入會員再報名");
  const d = parse(registerInput, input.data);
  const s = await deps.store.getSession(tenant.id, d.sessionId);
  if (!s) throw new ServiceError("not_found", "找不到這個場次");
  const e = await deps.store.getEventById(tenant.id, s.event_id);
  const t = await deps.store.getTicketType(tenant.id, d.ticketTypeId);
  if (!e || e.status !== "published" || !t || t.session_id !== s.id) throw new ServiceError("not_found", "找不到這個場次或票種");
  const contact = d.contact;
  const emailNorm = normalizeEmail(contact.email);
  let offerId: string | null = null;
  if (d.offerId) {
    if (!verifySigned("offer", d.offerId, d.offerToken)) throw new ServiceError("invalid", "候補保留連結無效");
    // M4：遞補連結不可轉讓——聯絡 email（正規化）必須是候補者本人；候補時是會員就必須是同一個會員登入
    const w = await deps.store.getWaitlist(tenant.id, d.offerId);
    if (!w || w.email_norm !== emailNorm || (w.member_id && w.member_id !== member?.id)) {
      throw new ServiceError("forbidden", "這個候補保留只限登記候補的本人使用（請用登記候補時的 Email；當時有登入會員的話請先登入同一個帳號）");
    }
    offerId = d.offerId;
  }
  await releaseExpiredSessionHolds(deps, tenant, s.id);
  const res = { session_id: s.id, ticket_type_id: t.id, qty: d.qty, unit_price: t.price, contact, member_id: member?.id ?? null, offer_id: offerId, email_norm: emailNorm };
  if (t.price === 0) {
    // M5：免費報名預設要 email 確認（已登入且 email 已驗證、且用的是帳號 email 的會員免確認；遞補連結本身已寄到候補者信箱，也免確認）
    const verifiedMember = !!member?.email_verified_at && normalizeEmail(member.email) === emailNorm;
    const needConfirm = settings.requireEmailConfirm !== false && !verifiedMember && !offerId;
    if (needConfirm && d.qty !== 1) throw new ServiceError("invalid", "尚未確認 Email 的報名每筆限 1 張（登入已驗證 Email 的會員帳號可一次報多張）");
    const pendingCap = Math.max(1, Math.floor((s.capacity * (settings.unconfirmedHoldPercent ?? DEFAULT_UNCONFIRMED_HOLD_PERCENT)) / 100));
    let id: string;
    try {
      id = await deps.store.reserveEventFree(tenant.id, { ...res, pending_email: needConfirm, pending_minutes: PENDING_HOLD_MINUTES, pending_cap: pendingCap });
    } catch (err) {
      // 審查 M6：待確認保留已達上限 → 不佔名額，改登記（待確認的）候補；確認後依順序遞補
      if (!(err instanceof ServiceError) || err.message !== RESERVE_ERRORS["pending cap"]!.message) throw err;
      for (const x of await deps.store.listWaitlist(tenant.id, s.id)) {
        if (x.email_norm === emailNorm && (x.status === "waiting" || x.status === "offered" || (x.status === "unconfirmed" && x.confirm_expires_at && new Date(x.confirm_expires_at).getTime() > Date.now()))) {
          return { kind: "waitlisted", waitlistId: x.id };
        }
        if (x.email_norm === emailNorm && x.status === "unconfirmed") await deps.store.updateWaitlist(tenant.id, x.id, ["unconfirmed"], { status: "cancelled" });
      }
      const w = await deps.store.insertWaitlist({
        tenant_id: tenant.id, session_id: s.id, ticket_type_id: t.id, member_id: member?.id ?? null, contact, email_norm: emailNorm, qty: 1,
        status: "unconfirmed", confirm_expires_at: new Date(Date.now() + EMAIL_CONFIRM_MINUTES * 60_000).toISOString(),
      });
      if (!w) throw new ServiceError("conflict", "這個 Email 已登記過這個場次的候補");
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: member ? `member:${member.id}` : "guest", action: "event.register_to_waitlist", payload: { waitlistId: w.id, reason: "pending_cap", pendingCap } });
      await mailSafe(deps, contact.email, `【${tenant.name}】請確認候補登記：${e.title}`, `${contact.name} 你好，\n\n目前「${e.title}」${fmtTaipei(s.starts_at)}待確認的報名較多，你的報名已改為候補登記。\n請在 ${EMAIL_CONFIRM_MINUTES} 分鐘內點下面的連結確認，確認後會依順序遞補，有名額時寄信通知你：\n${confirmUrl(deps.baseUrl, tenant, "w", w.id)}\n\n如果不是你本人登記，忽略這封信即可。`);
      return { kind: "waitlisted", waitlistId: w.id };
    }
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: member ? `member:${member.id}` : "guest", action: "event.register", payload: { registrationId: id, free: true, pendingEmail: needConfirm } });
    if (needConfirm) {
      const pending = (await deps.store.getRegistration(tenant.id, id))!;
      await mailSafe(
        deps,
        contact.email,
        `【${tenant.name}】請確認報名：${e.title}`,
        `${contact.name} 你好，\n\n請在 ${PENDING_HOLD_MINUTES} 分鐘內點下面的連結確認報名「${e.title}」${fmtTaipei(s.starts_at)}（逾時名額會釋出）：\n${confirmUrl(deps.baseUrl, tenant, "r", id)}\n\n如果不是你本人報名，忽略這封信即可。`,
      );
      return { kind: "pending", registration: pending };
    }
    const reg = await confirmRegistration(deps.store, tenant, id);
    await sendConfirmedMail(deps, tenant, e, s, t, reg);
    return { kind: "free", registration: reg, checkinCode: checkinCode(id) };
  }
  const line = t.price * d.qty;
  const r = await placeClassOrder(deps, {
    tenant,
    member,
    contact,
    item: { item_kind: "event_ticket", ref_id: t.id, name: `${e.title}｜${fmtTaipei(s.starts_at)}`, variant_label: t.name, sku: null, unit_price: t.price, qty: d.qty, line_total: line },
    reservation: { kind: "event", data: res },
    paymentMethod: d.paymentMethod ?? "offline",
    couponCode: d.couponCode,
    referralCode: d.referralCode,
    note: d.note,
    allowSandbox: input.allowSandbox,
    holdUntilMax: new Date(s.starts_at),
  });
  return { kind: "order", order: r.order, accessKey: r.accessKey, orderUrl: r.orderUrl, registrationId: r.reservationId };
}

/** held／免費 → confirmed，並寫入簽到碼雜湊（HMAC 衍生，可重算） */
async function confirmRegistration(store: Store, tenant: TenantRow, id: string): Promise<RegistrationRow> {
  const code = checkinCode(id);
  const r = await store.updateRegistration(tenant.id, id, ["held", "confirmed"], { status: "confirmed", checkin_code_hash: checkinHash(code) });
  if (!r) throw new ServiceError("conflict", "報名狀態已改變");
  return r;
}

async function sendConfirmedMail(deps: { sendMail?: CheckoutDeps["sendMail"]; baseUrl: string }, tenant: TenantRow, e: EventRow, s: EventSessionRow, t: TicketTypeRow, r: RegistrationRow) {
  const where = e.location_type === "online" ? "線上活動" : (e.location ?? "");
  const online = e.online_url && e.location_type !== "physical" ? `\n線上連結：${e.online_url}` : "";
  await mailSafe(
    deps,
    r.contact.email,
    `【${tenant.name}】報名成功：${e.title}`,
    `${r.contact.name} 你好，\n\n你已完成報名：\n${e.title}\n時間：${fmtTaipei(s.starts_at)}–${fmtTaipei(s.ends_at).slice(-5)}\n地點：${where}${online}\n票種：${t.name} × ${r.qty}${t.price ? `（${twd(t.price * r.qty)}）` : "（免費）"}\n\n簽到碼：${checkinCode(r.id)}\n（活動當天出示給工作人員即可）\n\n活動頁：${deps.baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/events/${e.slug}`,
  );
  const owner = (await ownerEmailFor(deps as CheckoutDeps, tenant)) ?? null;
  if (owner) await mailSafe(deps, owner, `【${tenant.name}】新報名：${e.title}（${fmtTaipei(s.starts_at)}）`, `${t.name} × ${r.qty}\n報名者：${maskContact(r.contact).name}（完整資料請到後台查看）`);
}

async function ownerEmailFor(deps: { store: Store }, tenant: TenantRow): Promise<string | undefined> {
  const s = await eventsSettingsFor(deps.store, tenant);
  if (s.ownerEmail) return s.ownerEmail;
  return (await publishedShopSettings(deps.store, tenant)).ownerEmail;
}

export const waitlistInput = z
  .object({
    sessionId: z.string().trim().min(1).max(64),
    ticketTypeId: z.string().trim().min(1).max(64),
    qty: z.coerce.number().int().min(1).max(20).default(1),
    contact: classContactInput,
  })
  .strict();

/** 登記候補：只在名額不足時開放；同一人（正規化 email）同場次只能排一次 */
export async function joinWaitlist(deps: CheckoutDeps, input: { tenant: TenantRow; member: MemberRow | null; data: unknown }) {
  const { tenant, member } = input;
  if (!(await eventsActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放活動報名");
  const d = parse(waitlistInput, input.data);
  const s = await deps.store.getSession(tenant.id, d.sessionId);
  const t = await deps.store.getTicketType(tenant.id, d.ticketTypeId);
  const e = s ? await deps.store.getEventById(tenant.id, s.event_id) : null;
  if (!s || !t || !e || t.session_id !== s.id || e.status !== "published" || s.status !== "scheduled") throw new ServiceError("not_found", "找不到這個場次或票種");
  if (d.qty > t.max_per_order) throw new ServiceError("invalid", `每筆最多 ${t.max_per_order} 張`);
  await releaseExpiredSessionHolds(deps, tenant, s.id);
  const a = await sessionAvailability(deps.store, s);
  const ticketLeft = t.quota === null ? Infinity : t.quota - (a.byTicket[t.id] ?? 0);
  if (a.remaining >= d.qty && ticketLeft >= d.qty && a.waiting === 0) throw new ServiceError("conflict", "目前還有名額，請直接報名");
  const emailNorm = normalizeEmail(d.contact.email);
  // M5：每個 email 每場次只能一筆有效報名（已報名就不必候補）
  const existing = (await deps.store.listRegistrations(tenant.id, { sessionId: s.id, status: ["held", "confirmed"], limit: 5000, offset: 0 })).rows;
  if (existing.some((r) => r.email_norm === emailNorm && (r.status === "confirmed" || !!r.order_id || !r.hold_expires_at || new Date(r.hold_expires_at).getTime() > Date.now()))) {
    throw new ServiceError("conflict", "這個 Email 已報名過這個場次");
  }
  // 逾期未確認的候補登記作廢，讓本人可以重新登記
  for (const x of await deps.store.listWaitlist(tenant.id, s.id)) {
    if (x.email_norm === emailNorm && x.status === "unconfirmed" && (!x.confirm_expires_at || new Date(x.confirm_expires_at).getTime() <= Date.now())) await deps.store.updateWaitlist(tenant.id, x.id, ["unconfirmed"], { status: "cancelled" });
  }
  const settings = await eventsSettingsFor(deps.store, tenant);
  const verifiedMember = !!member?.email_verified_at && normalizeEmail(member.email) === emailNorm;
  const needConfirm = settings.requireEmailConfirm !== false && !verifiedMember;
  const w = await deps.store.insertWaitlist({
    tenant_id: tenant.id, session_id: s.id, ticket_type_id: t.id, member_id: member?.id ?? null, contact: d.contact, email_norm: emailNorm, qty: d.qty,
    status: needConfirm ? "unconfirmed" : "waiting",
    confirm_expires_at: needConfirm ? new Date(Date.now() + EMAIL_CONFIRM_MINUTES * 60_000).toISOString() : null,
  });
  if (!w) throw new ServiceError("conflict", "你已經在這個場次的候補名單中了");
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: member ? `member:${member.id}` : "guest", action: "event.waitlist", payload: { sessionId: s.id, waitlistId: w.id, pendingEmail: needConfirm } });
  if (needConfirm) {
    await mailSafe(deps, w.contact.email, `【${tenant.name}】請確認候補登記：${e.title}`, `${w.contact.name} 你好，\n\n請在 ${EMAIL_CONFIRM_MINUTES} 分鐘內點下面的連結確認候補登記「${e.title}」${fmtTaipei(s.starts_at)}（${t.name} × ${w.qty}）：\n${confirmUrl(deps.baseUrl, tenant, "w", w.id)}\n\n確認後才會排入候補順序。如果不是你本人登記，忽略這封信即可。`);
    return { waitlistId: w.id, position: 0, pendingEmail: true };
  }
  await mailSafe(deps, w.contact.email, `【${tenant.name}】已登記候補：${e.title}`, `${w.contact.name} 你好，\n\n你已登記「${e.title}」${fmtTaipei(s.starts_at)} 的候補（${t.name} × ${w.qty}）。有名額釋出時會依登記順序寄信通知你，並為你保留一段時間。`);
  // 剛好有空位（例如前面有人放棄）→ 立刻嘗試遞補
  await promoteWaitlist(deps, tenant, s.id);
  return { waitlistId: w.id, position: (await deps.store.listWaitlist(tenant.id, s.id)).filter((x) => x.status === "waiting").findIndex((x) => x.id === w.id) + 1, pendingEmail: false };
}

export function offerUrl(baseUrl: string, tenant: TenantRow, e: EventRow, w: WaitlistRow) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/events/${e.slug}?offer=${encodeURIComponent(w.id)}&t=${encodeURIComponent(signFor("offer", w.id))}`;
}

/**
 * 候補遞補（冪等）：builder_offer_waitlist 在交易內把過期保留標 lapsed、依序把空位保留給下一位（保留本身佔名額，
 * 同一個空位不會給兩個人）。只對「這次新給出的保留」寄信。
 */
export async function promoteWaitlist(deps: { store: Store; sendMail?: CheckoutDeps["sendMail"]; baseUrl: string }, tenant: TenantRow, sessionId: string) {
  const fresh = (await deps.store.getTenantById(tenant.id)) ?? tenant;
  const hours = (await eventsSettingsFor(deps.store, fresh)).waitlistOfferHours ?? DEFAULT_OFFER_HOURS;
  const offers = await deps.store.offerWaitlist(tenant.id, sessionId, hours);
  if (!offers.length) return [];
  const s = (await deps.store.getSession(tenant.id, sessionId))!;
  const e = (await deps.store.getEventById(tenant.id, s.event_id))!;
  for (const w of offers) {
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:events", action: "event.waitlist_offer", payload: { waitlistId: w.id, sessionId, until: w.offer_expires_at } });
    await mailSafe(
      deps,
      w.contact.email,
      `【${fresh.name}】候補遞補通知：${e.title} 有名額了`,
      `${w.contact.name} 你好，\n\n「${e.title}」${fmtTaipei(s.starts_at)} 釋出了名額，已為你保留到 ${fmtTaipei(w.offer_expires_at!)}。\n請在期限內點下面的連結完成報名（逾時會依序讓給下一位）：\n${offerUrl(deps.baseUrl, fresh, e, w)}`,
    );
  }
  return offers;
}

/** 前台：驗證候補保留連結（簽章＋仍有效） */
export async function offerFor(store: Store, tenant: TenantRow, offerId: string | undefined, token: string | undefined): Promise<WaitlistRow | null> {
  if (!offerId || !verifySigned("offer", offerId, token)) return null;
  const w = await store.getWaitlist(tenant.id, offerId);
  if (!w || w.status !== "offered" || !w.offer_expires_at || new Date(w.offer_expires_at).getTime() <= Date.now()) return null;
  return w;
}

/* ================================================================== 付款／取消 hook */

async function onEventOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  const regs = (await deps.store.listRegistrations(tenant.id, { orderId: order.id, status: ["held"], limit: 20, offset: 0 })).rows;
  for (const r of regs) {
    // M2：失敗要丟出（由 runPaidHooks 記錄、cron／讀取時補做）；已被別的流程確認＝冪等略過
    const reg = await deps.store.updateRegistration(tenant.id, r.id, ["held"], { status: "confirmed", checkin_code_hash: checkinHash(checkinCode(r.id)), hold_expires_at: null });
    if (!reg) {
      const cur = await deps.store.getRegistration(tenant.id, r.id);
      if (cur?.status === "confirmed") continue;
      throw new Error(`報名 ${r.id} 已付款但狀態為 ${cur?.status ?? "不存在"}，無法確認（需人工處理）`);
    }
    const [s, t, e] = await Promise.all([deps.store.getSession(tenant.id, r.session_id), deps.store.getTicketType(tenant.id, r.ticket_type_id), deps.store.getEventById(tenant.id, r.event_id)]);
    if (s && t && e) await sendConfirmedMail(deps, tenant, e, s, t, reg);
  }
}

async function onEventOrderCancelled(store: Store, tenant: TenantRow, order: OrderRow, cd?: CancelDeps) {
  // 名額已在 builder_cancel_order 同一交易釋放；這裡只負責通知候補（冪等）
  const regs = (await store.listRegistrations(tenant.id, { orderId: order.id, limit: 20, offset: 0 })).rows;
  if (!regs.length) return;
  const deps = { store, sendMail: cd ? cd.sendMail : getMailer(), baseUrl: (cd?.baseUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "") };
  for (const sid of new Set(regs.map((r) => r.session_id))) await promoteWaitlist(deps, tenant, sid);
}

registerOrderHooks({ name: "events", paid: onEventOrderPaid, cancelled: onEventOrderCancelled });

/* ================================================================== cron：候補遞補、提醒 */

/** 每日 cron：所有有候補的場次跑一次遞補（過期保留換下一位）；「今天稍晚與明天」的場次寄提醒（每筆只寄一次） */
export async function runEventsCron(deps: { store: Store; sendMail?: CheckoutDeps["sendMail"]; baseUrl: string }, now = new Date()) {
  let offered = 0;
  for (const s of await deps.store.listSessionsWithWaitlist(200)) {
    const t = await deps.store.getTenantById(s.tenant_id);
    if (!t) continue;
    // 先釋放這個場次已逾期的付款保留（線上付款單先權威回查；取消 hook 會順便遞補）
    await releaseExpiredSessionHolds(deps, t, s.id);
    offered += (await promoteWaitlist(deps, t, s.id)).length;
  }
  const tomorrow = taipeiDate(now.getTime() + 86400_000);
  const until = taipeiAt(tomorrow, 24 * 60);
  let reminded = 0;
  for (const s of await deps.store.listSessionsStartingBetween(now.toISOString(), until.toISOString(), 500)) {
    reminded += await remindSession(deps, s);
  }
  return { offered, reminded };
}

export async function remindSession(deps: { store: Store; sendMail?: CheckoutDeps["sendMail"]; baseUrl: string }, s: EventSessionRow): Promise<number> {
  const tenant = await deps.store.getTenantById(s.tenant_id);
  if (!tenant || !(await eventsActive(deps.store, tenant.id))) return 0;
  if ((await eventsSettingsFor(deps.store, tenant)).reminders === false) return 0;
  const e = await deps.store.getEventById(tenant.id, s.event_id);
  if (!e || e.status !== "published") return 0;
  const regs = (await deps.store.listRegistrations(tenant.id, { sessionId: s.id, status: ["confirmed"], limit: 5000, offset: 0 })).rows.filter((r) => !r.reminder_sent_at);
  let n = 0;
  for (const r of regs) {
    // 條件式（reminder_sent_at 為 null 才寫）：併發／重跑 cron 都只寄一次
    const claimed = await deps.store.updateRegistration(tenant.id, r.id, ["confirmed"], { reminder_sent_at: new Date().toISOString() }, { requireNull: ["reminder_sent_at"] });
    if (!claimed) continue;
    n++;
    await mailSafe(
      deps,
      r.contact.email,
      `【${tenant.name}】活動提醒：${e.title}（${fmtTaipei(s.starts_at)}）`,
      `${r.contact.name} 你好，\n\n提醒你「${e.title}」即將開始：\n時間：${fmtTaipei(s.starts_at)}\n地點：${e.location_type === "online" ? "線上" : (e.location ?? "")}${e.online_url && e.location_type !== "physical" ? `\n線上連結：${e.online_url}` : ""}\n簽到碼：${checkinCode(r.id)}`,
    );
  }
  return n;
}

/** 會員中心：我的報名 */
export async function memberRegistrations(store: Store, tenant: TenantRow, member: MemberRow) {
  const r = await store.listRegistrations(tenant.id, { memberId: member.id, status: ["held", "confirmed", "cancelled"], limit: 50, offset: 0 });
  const out = [];
  for (const reg of r.rows.slice().reverse()) {
    const [s, e] = await Promise.all([store.getSession(tenant.id, reg.session_id), store.getEventById(tenant.id, reg.event_id)]);
    if (s && e) out.push({ reg, session: s, event: e, code: reg.status === "confirmed" ? checkinCode(reg.id) : null });
  }
  return out;
}
