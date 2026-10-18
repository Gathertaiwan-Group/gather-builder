import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { ReservationBridge } from "./memory-commerce";
import type {
  CourseRow,
  EnrollmentRow,
  LessonRow,
  BookingReservation,
  BookingRow,
  HoursRow,
  OverrideRow,
  ProviderRow,
  ServiceRow,
  ClassesStore,
  ClassReservation,
  EventReservation,
  EventRow,
  EventSessionRow,
  PiiAccessRow,
  RegistrationRow,
  HookFailureRow,
  Store,
  TicketTypeRow,
  WaitlistRow,
} from "./types";
import { RESERVE_ERRORS } from "./reserve-errors";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

export type MemoryClasses = Omit<ClassesStore, "placeClassOrder">;

/**
 * 第四批的記憶體實作，語意與 SQL 函式（builder_reserve_event／builder_offer_waitlist／builder_release_order_reservations）一致：
 * 每個「檢查＋寫入」都在同一個同步區段（JS 單執行緒）完成，等同 DB 交易內鎖住場次列。
 */
export function createMemoryClassesStore(): { store: MemoryClasses; bridge: ReservationBridge; attach(s: Store): void } {
  const events = new Map<string, EventRow>();
  const sessions = new Map<string, EventSessionRow>();
  const tickets = new Map<string, TicketTypeRow>();
  const regs = new Map<string, RegistrationRow>();
  const waitlist = new Map<string, WaitlistRow>();
  // 記憶體版的建立順序（毫秒時間戳可能相同；DB 是微秒 now()＋id，這裡用插入順序確保嚴格 FIFO）
  const waitSeq = new Map<string, number>();
  const fifo = (a: WaitlistRow, b: WaitlistRow) => a.created_at.localeCompare(b.created_at) || (waitSeq.get(a.id) ?? 0) - (waitSeq.get(b.id) ?? 0);
  const pii: PiiAccessRow[] = [];
  const providers = new Map<string, ProviderRow>();
  const services = new Map<string, ServiceRow>();
  let hours: HoursRow[] = [];
  const overrides = new Map<string, OverrideRow>();
  const bookings = new Map<string, BookingRow>();
  const courses = new Map<string, CourseRow>();
  const lessons = new Map<string, LessonRow>();
  const enrollments = new Map<string, EnrollmentRow>();
  const progress = new Map<string, { tenant_id: string; course_id: string; lesson_id: string; member_id: string; completed_at: string }>();
  const liveBooking = (b: BookingRow) => b.status === "held" || b.status === "confirmed";
  const clash = (providerId: string, startMs: number, blockMs: number, exceptId?: string) =>
    [...bookings.values()].some((b) => b.provider_id === providerId && b.id !== exceptId && liveBooking(b) && new Date(b.starts_at).getTime() < blockMs && startMs < new Date(b.block_until).getTime());

  /** 同 builder_reserve_booking：提供者啟用、服務上架、未來時間、[starts, block) 不重疊 */
  function reserveBookingSync(tenantId: string, orderId: string | null, res: BookingReservation): string {
    const p = providers.get(res.provider_id);
    if (!p || p.tenant_id !== tenantId || !p.active) fail("provider unavailable");
    const sv = services.get(res.service_id);
    if (!sv || sv.tenant_id !== tenantId || sv.status !== "published") fail("service unavailable");
    const st = new Date(res.starts_at).getTime();
    if (st <= Date.now()) fail("slot taken");
    if (clash(res.provider_id, st, new Date(res.block_until).getTime())) fail("slot taken");
    const id = randomUUID();
    bookings.set(id, {
      id,
      tenant_id: tenantId,
      provider_id: res.provider_id,
      service_id: res.service_id,
      order_id: orderId,
      member_id: res.member_id || null,
      contact: clone(res.contact),
      starts_at: new Date(res.starts_at).toISOString(),
      ends_at: new Date(res.ends_at).toISOString(),
      block_until: new Date(res.block_until).toISOString(),
      status: orderId ? "held" : "confirmed",
      price: res.price,
      amount_due: res.amount_due,
      note: res.note || null,
      reminder_sent_at: null,
      refund_required: false,
      cancelled_at: null,
      cancel_reason: null,
      cancelled_by: null,
      rescheduled_at: null,
      created_at: now(),
      updated_at: now(),
    });
    return id;
  }
  let root: Store | null = null;

  const fail = (code: string): never => {
    const e = RESERVE_ERRORS[code]!;
    throw new ServiceError(e.code, e.message);
  };
  const activeOffer = (w: WaitlistRow, t = Date.now()) => w.status === "offered" && !!w.offer_expires_at && new Date(w.offer_expires_at).getTime() > t;
  const usedSeats = (s: EventSessionRow) =>
    [...regs.values()].filter((r) => r.session_id === s.id && liveReg(r)).reduce((n, r) => n + r.qty, 0) +
    s.offline_seats +
    [...waitlist.values()].filter((w) => w.session_id === s.id && activeOffer(w)).reduce((n, w) => n + w.qty, 0);
  const usedTicket = (t: TicketTypeRow) =>
    [...regs.values()].filter((r) => r.ticket_type_id === t.id && liveReg(r)).reduce((n, r) => n + r.qty, 0) +
    [...waitlist.values()].filter((w) => w.ticket_type_id === t.id && activeOffer(w)).reduce((n, w) => n + w.qty, 0);

  /** 同 SQL：鎖場次後先把逾期未確認 email 的免費保留標 expired */
  const expireEmailHolds = (sessionId: string) => {
    const t = Date.now();
    for (const r of regs.values()) {
      if (r.session_id === sessionId && r.status === "held" && !r.order_id && r.hold_expires_at && new Date(r.hold_expires_at).getTime() <= t) {
        regs.set(r.id, { ...r, status: "expired", cancelled_at: now(), cancel_reason: "email_unconfirmed", updated_at: now() });
      }
    }
  };
  const liveReg = (r: RegistrationRow, t = Date.now()) => r.status === "confirmed" || (r.status === "held" && (!!r.order_id || !r.hold_expires_at || new Date(r.hold_expires_at).getTime() > t));

  function reserveEventSync(tenantId: string, orderId: string | null, res: EventReservation): string {
    const s = sessions.get(res.session_id);
    if (!s || s.tenant_id !== tenantId) fail("session not found");
    expireEmailHolds(s!.id);
    const ev = events.get(s!.event_id);
    if (s!.status !== "scheduled" || ev?.status !== "published") fail("session closed");
    if (new Date(s!.starts_at).getTime() <= Date.now()) fail("session started");
    const t = tickets.get(res.ticket_type_id);
    if (!t || t.session_id !== s!.id || t.tenant_id !== tenantId || !t.active) fail("ticket unavailable");
    const nowMs = Date.now();
    if ((t!.sales_start && new Date(t!.sales_start).getTime() > nowMs) || (t!.sales_end && new Date(t!.sales_end).getTime() <= nowMs)) fail("ticket not on sale");
    if (!Number.isInteger(res.qty) || res.qty < 1 || res.qty > t!.max_per_order) fail("qty limit");
    if (res.unit_price !== t!.price) fail("price changed");
    const emailNorm = res.email_norm || null;
    if (emailNorm && [...regs.values()].some((r) => r.session_id === s!.id && r.email_norm === emailNorm && (r.status === "held" || r.status === "confirmed"))) fail("already registered");
    const pending = !!res.pending_email && !orderId;
    // 審查 M6（同 SQL）：未確認保留每筆 1 張、每場次總量上限
    if (pending) {
      if (res.qty !== 1) fail("pending qty");
      const cap = Math.max(1, res.pending_cap ?? 1_000_000);
      const used = [...regs.values()].filter((r) => r.session_id === s!.id && r.status === "held" && !r.order_id && r.hold_expires_at && new Date(r.hold_expires_at).getTime() > Date.now()).length;
      if (used + 1 > cap) fail("pending cap");
    }
    let offer: WaitlistRow | undefined;
    if (res.offer_id) {
      offer = waitlist.get(res.offer_id);
      if (!offer || offer.tenant_id !== tenantId || offer.session_id !== s!.id || offer.ticket_type_id !== t!.id || !activeOffer(offer) || (emailNorm && offer.email_norm !== emailNorm)) fail("offer invalid");
      if (res.qty > offer!.qty) fail("qty limit");
    }
    // 認領的保留不再佔名額（SQL 先把它改成 claimed 再加總）
    const offerQty = offer ? offer.qty : 0;
    if (usedSeats(s!) - offerQty + res.qty > s!.capacity) fail("sold out");
    if (t!.quota !== null && usedTicket(t!) - offerQty + res.qty > t!.quota) fail("ticket sold out");
    const id = randomUUID();
    const row: RegistrationRow = {
      id,
      tenant_id: tenantId,
      event_id: s!.event_id,
      session_id: s!.id,
      ticket_type_id: t!.id,
      order_id: orderId,
      member_id: res.member_id || null,
      qty: res.qty,
      unit_price: t!.price,
      contact: clone(res.contact),
      status: orderId || pending ? "held" : "confirmed",
      source: offer ? "waitlist" : "online",
      checkin_code_hash: res.checkin_code_hash || null,
      email_norm: emailNorm,
      hold_expires_at: pending ? new Date(Date.now() + Math.max(5, Math.min(res.pending_minutes ?? 15, 120)) * 60_000).toISOString() : null,
      email_confirmed_at: null,
      checked_in_at: null,
      checked_in_by: null,
      reminder_sent_at: null,
      refund_required: false,
      cancelled_at: null,
      cancel_reason: null,
      created_at: now(),
      updated_at: now(),
    };
    if (row.checkin_code_hash && [...regs.values()].some((r) => r.checkin_code_hash === row.checkin_code_hash)) throw new ServiceError("conflict", "資料重複");
    regs.set(id, row);
    if (offer) waitlist.set(offer.id, { ...offer, status: "claimed", claimed_registration_id: id, updated_at: now() });
    return id;
  }

  const bridge: ReservationBridge = {
    reserveSync(tenantId, orderId, res: NonNullable<ClassReservation>) {
      if (res.kind === "event") return reserveEventSync(tenantId, orderId, res.data);
      return bookingBridge.reserve(tenantId, orderId, res);
    },
    releaseSync(tenantId, orderId, cancelReason) {
      for (const r of regs.values()) {
        if (r.tenant_id === tenantId && r.order_id === orderId && (r.status === "held" || r.status === "confirmed")) {
          regs.set(r.id, { ...r, status: cancelReason === "expired" ? "expired" : "cancelled", cancelled_at: now(), cancel_reason: cancelReason || "order_cancelled", updated_at: now() });
        }
      }
      bookingBridge.release(tenantId, orderId, cancelReason);
    },
  };

  /** booking 模組的記憶體實作在載入時接上（見 memory-booking.ts） */
  const bookingBridge = {
    reserve: (tenantId: string, orderId: string, res: NonNullable<ClassReservation>): string => {
      if (res.kind !== "booking") throw new Error("builder: unknown reservation kind");
      return reserveBookingSync(tenantId, orderId, res.data);
    },
    release: (tenantId: string, orderId: string, reason: string) => {
      for (const b of bookings.values()) {
        if (b.tenant_id === tenantId && b.order_id === orderId && liveBooking(b)) {
          bookings.set(b.id, { ...b, status: reason === "expired" ? "expired" : "cancelled", cancelled_at: now(), cancel_reason: reason || "order_cancelled", cancelled_by: "order", updated_at: now() });
        }
      }
    },
  };

  const page = <T>(rows: T[], limit: number, offset: number) => ({ rows: clone(rows.slice(offset, offset + limit)), total: rows.length });
  const own = <T extends { tenant_id: string }>(m: Map<string, T>, tenantId: string, id: string) => {
    const r = m.get(id);
    return r && r.tenant_id === tenantId ? r : undefined;
  };

  const hookFailures = new Map<string, HookFailureRow>();
  const store: MemoryClasses = {
    async recordHookFailure(row) {
      const cur = [...hookFailures.values()].find((f) => f.order_id === row.order_id && f.hook === row.hook && f.event === row.event);
      if (!cur) {
        const f: HookFailureRow = { id: randomUUID(), tenant_id: row.tenant_id, order_id: row.order_id, hook: row.hook, event: row.event, attempts: 1, last_error: row.error, first_failed_at: now(), last_attempt_at: now(), resolved_at: null, alerted_at: null };
        hookFailures.set(f.id, f);
        return;
      }
      hookFailures.set(cur.id, { ...cur, attempts: cur.resolved_at ? 1 : cur.attempts + 1, last_error: row.error, last_attempt_at: now(), resolved_at: null, alerted_at: cur.resolved_at ? null : cur.alerted_at });
    },
    async listOpenHookFailures(opts) {
      return clone(
        [...hookFailures.values()]
          .filter((f) => !f.resolved_at && f.attempts < opts.maxAttempts && (!opts.orderId || f.order_id === opts.orderId) && (!opts.tenantId || f.tenant_id === opts.tenantId))
          .sort((a, b) => a.last_attempt_at.localeCompare(b.last_attempt_at))
          .slice(0, opts.limit),
      );
    },
    async resolveHookFailure(id, how) {
      const f = hookFailures.get(id);
      if (f && !f.resolved_at) hookFailures.set(id, { ...f, resolved_at: now(), last_error: how === "obsolete" ? "obsolete" : f.last_error });
    },
    async bumpHookFailure(id, error) {
      const f = hookFailures.get(id)!;
      hookFailures.set(id, { ...f, attempts: f.attempts + 1, last_error: error, last_attempt_at: now() });
      return f.attempts + 1;
    },
    async markHookFailureAlerted(id) {
      const f = hookFailures.get(id);
      if (!f || f.alerted_at) return false;
      hookFailures.set(id, { ...f, alerted_at: now() });
      return true;
    },
    async insertEvent(row) {
      if ([...events.values()].some((e) => e.tenant_id === row.tenant_id && e.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const r: EventRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      events.set(r.id, r);
      return clone(r);
    },
    async updateEvent(tenantId, id, patch) {
      const e = own(events, tenantId, id);
      if (!e) return null;
      if (patch.slug && patch.slug !== e.slug && [...events.values()].some((x) => x.tenant_id === tenantId && x.slug === patch.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const next = { ...e, ...clone(patch), updated_at: now() };
      events.set(id, next);
      return clone(next);
    },
    async getEventById(tenantId, id) {
      return clone(own(events, tenantId, id) ?? null);
    },
    async getEventBySlug(tenantId, slug) {
      return clone([...events.values()].find((e) => e.tenant_id === tenantId && e.slug === slug) ?? null);
    },
    async listEvents(tenantId, opts) {
      const rows = [...events.values()].filter((e) => e.tenant_id === tenantId && (!opts.status || e.status === opts.status)).sort((a, b) => a.sort - b.sort || b.created_at.localeCompare(a.created_at));
      return page(rows, opts.limit, opts.offset);
    },
    async insertSession(row) {
      const r: EventSessionRow = { status: "scheduled", ...clone(row), id: randomUUID(), cancelled_at: null, cancel_reason: null, created_at: now(), updated_at: now() };
      sessions.set(r.id, r);
      return clone(r);
    },
    async updateSession(tenantId, id, patch) {
      const s = own(sessions, tenantId, id);
      if (!s) return null;
      const next = { ...s, ...patch, updated_at: now() };
      sessions.set(id, next);
      return clone(next);
    },
    async getSession(tenantId, id) {
      return clone(own(sessions, tenantId, id) ?? null);
    },
    async listSessions(tenantId, eventIds) {
      return clone([...sessions.values()].filter((s) => s.tenant_id === tenantId && eventIds.includes(s.event_id)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
    },
    async listSessionsStartingBetween(fromIso, toIso, limit) {
      return clone([...sessions.values()].filter((s) => s.status === "scheduled" && s.starts_at >= fromIso && s.starts_at < toIso).slice(0, limit));
    },
    async listSessionsWithWaitlist(limit) {
      const ids = new Set([...waitlist.values()].filter((w) => w.status === "waiting" || w.status === "offered").map((w) => w.session_id));
      return [...sessions.values()].filter((s) => ids.has(s.id) && new Date(s.starts_at).getTime() > Date.now()).slice(0, limit).map((s) => ({ id: s.id, tenant_id: s.tenant_id }));
    },
    async insertTicketType(row) {
      const r: TicketTypeRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      tickets.set(r.id, r);
      return clone(r);
    },
    async updateTicketType(tenantId, id, patch) {
      const t = own(tickets, tenantId, id);
      if (!t) return null;
      const next = { ...t, ...patch, updated_at: now() };
      tickets.set(id, next);
      return clone(next);
    },
    async getTicketType(tenantId, id) {
      return clone(own(tickets, tenantId, id) ?? null);
    },
    async listTicketTypes(tenantId, sessionIds) {
      return clone([...tickets.values()].filter((t) => t.tenant_id === tenantId && sessionIds.includes(t.session_id)).sort((a, b) => a.sort - b.sort || a.price - b.price));
    },
    async reserveEventFree(tenantId, res) {
      return reserveEventSync(tenantId, null, res);
    },
    async getRegistration(tenantId, id) {
      return clone(own(regs, tenantId, id) ?? null);
    },
    async getRegistrationByCheckinHash(tenantId, hash) {
      return clone([...regs.values()].find((r) => r.tenant_id === tenantId && r.checkin_code_hash === hash) ?? null);
    },
    async listRegistrations(tenantId, opts) {
      const rows = [...regs.values()]
        .filter(
          (r) =>
            r.tenant_id === tenantId &&
            (!opts.sessionId || r.session_id === opts.sessionId) &&
            (!opts.eventId || r.event_id === opts.eventId) &&
            (!opts.orderId || r.order_id === opts.orderId) &&
            (!opts.memberId || r.member_id === opts.memberId) &&
            (!opts.status || opts.status.includes(r.status)),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return page(rows, opts.limit, opts.offset);
    },
    async updateRegistration(tenantId, id, from, patch, opts) {
      const r = own(regs, tenantId, id);
      if (!r || !from.includes(r.status)) return null;
      for (const k of opts?.requireNull ?? []) if (r[k] !== null) return null;
      if (patch.checkin_code_hash && [...regs.values()].some((x) => x.id !== id && x.checkin_code_hash === patch.checkin_code_hash)) throw new ServiceError("conflict", "資料重複");
      const next = { ...r, ...patch, updated_at: now() };
      regs.set(id, next);
      return clone(next);
    },
    async sessionUsage(tenantId, sessionId) {
      const live = [...regs.values()].filter((r) => r.tenant_id === tenantId && r.session_id === sessionId && liveReg(r));
      const offers = [...waitlist.values()].filter((w) => w.tenant_id === tenantId && w.session_id === sessionId && activeOffer(w));
      const byTicket: Record<string, number> = {};
      for (const r of live) byTicket[r.ticket_type_id] = (byTicket[r.ticket_type_id] ?? 0) + r.qty;
      for (const w of offers) byTicket[w.ticket_type_id] = (byTicket[w.ticket_type_id] ?? 0) + w.qty;
      return {
        taken: live.reduce((n, r) => n + r.qty, 0),
        offered: offers.reduce((n, w) => n + w.qty, 0),
        byTicket,
        waiting: [...waitlist.values()].filter((w) => w.tenant_id === tenantId && w.session_id === sessionId && w.status === "waiting").length,
      };
    },
    async listExpiredHeldOrderIdsForSession(tenantId, sessionId, nowIso) {
      const ids = [...new Set([...regs.values()].filter((r) => r.tenant_id === tenantId && r.session_id === sessionId && r.status === "held" && r.order_id).map((r) => r.order_id!))];
      const out: string[] = [];
      for (const id of ids) {
        const o = await root?.getOrderById(tenantId, id);
        if (o && o.status === "pending_payment" && o.expires_at && o.expires_at < nowIso) out.push(id);
      }
      return out;
    },
    async insertWaitlist(row) {
      if ([...waitlist.values()].some((w) => w.session_id === row.session_id && w.email_norm === row.email_norm && (w.status === "unconfirmed" || w.status === "waiting" || w.status === "offered"))) return null;
      const r: WaitlistRow = { ...clone(row), id: randomUUID(), status: row.status ?? "waiting", confirm_expires_at: row.confirm_expires_at ?? null, offered_at: null, offer_expires_at: null, claimed_registration_id: null, created_at: now(), updated_at: now() };
      waitlist.set(r.id, r);
      waitSeq.set(r.id, waitSeq.size + 1);
      return clone(r);
    },
    async getWaitlist(tenantId, id) {
      return clone(own(waitlist, tenantId, id) ?? null);
    },
    async listWaitlist(tenantId, sessionId) {
      return clone([...waitlist.values()].filter((w) => w.tenant_id === tenantId && w.session_id === sessionId).sort(fifo));
    },
    async updateWaitlist(tenantId, id, from, patch) {
      const w = own(waitlist, tenantId, id);
      if (!w || !from.includes(w.status)) return null;
      const next = { ...w, ...patch, updated_at: now() };
      waitlist.set(id, next);
      return clone(next);
    },
    async offerWaitlist(tenantId, sessionId, hours) {
      const s = own(sessions, tenantId, sessionId);
      if (!s) return [];
      expireEmailHolds(s.id);
      const t = Date.now();
      for (const w of waitlist.values()) {
        if (w.session_id === s.id && w.status === "offered" && (!w.offer_expires_at || new Date(w.offer_expires_at).getTime() <= t)) waitlist.set(w.id, { ...w, status: "lapsed", updated_at: now() });
      }
      const ev = events.get(s.event_id);
      if (s.status !== "scheduled" || ev?.status !== "published" || new Date(s.starts_at).getTime() <= t) return [];
      const until = new Date(Math.min(t + Math.max(1, Math.min(hours, 168)) * 3600_000, new Date(s.starts_at).getTime())).toISOString();
      const out: WaitlistRow[] = [];
      // 同 SQL（L3）：票種停用或不在販售期間的候補者略過；其餘嚴格 FIFO，放不下就停
      for (const w of [...waitlist.values()].filter((x) => x.session_id === s.id && x.status === "waiting").sort(fifo)) {
        const tt = tickets.get(w.ticket_type_id);
        if (!tt || !tt.active || (tt.sales_start && new Date(tt.sales_start).getTime() > t) || (tt.sales_end && new Date(tt.sales_end).getTime() <= t)) continue;
        if (usedSeats(s) + w.qty > s.capacity) break;
        if (tt.quota !== null && usedTicket(tt) + w.qty > tt.quota) break;
        const next: WaitlistRow = { ...w, status: "offered", offered_at: now(), offer_expires_at: until, updated_at: now() };
        waitlist.set(w.id, next);
        out.push(clone(next));
      }
      return out;
    },
    /* ------------------------------------------------ booking */
    async insertProvider(row) {
      const r: ProviderRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      providers.set(r.id, r);
      return clone(r);
    },
    async listProviders(tenantId) {
      return clone([...providers.values()].filter((p) => p.tenant_id === tenantId).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)));
    },
    async getProvider(tenantId, id) {
      return clone(own(providers, tenantId, id) ?? null);
    },
    async insertService(row) {
      if ([...services.values()].some((x) => x.tenant_id === row.tenant_id && x.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const r: ServiceRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      services.set(r.id, r);
      return clone(r);
    },
    async updateService(tenantId, id, patch) {
      const x = own(services, tenantId, id);
      if (!x) return null;
      const next = { ...x, ...clone(patch), updated_at: now() };
      services.set(id, next);
      return clone(next);
    },
    async getServiceById(tenantId, id) {
      return clone(own(services, tenantId, id) ?? null);
    },
    async getServiceBySlug(tenantId, slug) {
      return clone([...services.values()].find((x) => x.tenant_id === tenantId && x.slug === slug) ?? null);
    },
    async listServices(tenantId, opts) {
      return clone([...services.values()].filter((x) => x.tenant_id === tenantId && (!opts.status || x.status === opts.status)).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)));
    },
    async replaceWeeklyHours(tenantId, providerId, rows) {
      hours = hours.filter((h) => !(h.tenant_id === tenantId && h.provider_id === providerId));
      const added = rows.map((r) => ({ ...r, id: randomUUID(), tenant_id: tenantId, provider_id: providerId }));
      hours.push(...added);
      return clone(added);
    },
    async listWeeklyHours(tenantId, providerId) {
      return clone(hours.filter((h) => h.tenant_id === tenantId && h.provider_id === providerId).sort((a, b) => a.weekday - b.weekday || a.start_min - b.start_min));
    },
    async insertOverride(row) {
      const r: OverrideRow = { ...clone(row), id: randomUUID(), created_at: now() };
      overrides.set(r.id, r);
      return clone(r);
    },
    async listOverrides(tenantId, providerId, fromDate, toDate) {
      return clone([...overrides.values()].filter((o) => o.tenant_id === tenantId && o.provider_id === providerId && o.date >= fromDate && o.date <= toDate).sort((a, b) => a.date.localeCompare(b.date)));
    },
    async reserveBookingFree(tenantId, res) {
      return reserveBookingSync(tenantId, null, res);
    },
    async getBooking(tenantId, id) {
      return clone(own(bookings, tenantId, id) ?? null);
    },
    async listBookings(tenantId, opts) {
      const rows = [...bookings.values()]
        .filter(
          (b) =>
            b.tenant_id === tenantId &&
            (!opts.providerId || b.provider_id === opts.providerId) &&
            (!opts.fromIso || b.starts_at >= opts.fromIso) &&
            (!opts.toIso || b.starts_at < opts.toIso) &&
            (!opts.status || opts.status.includes(b.status)) &&
            (!opts.orderId || b.order_id === opts.orderId) &&
            (!opts.memberId || b.member_id === opts.memberId),
        )
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      return page(rows, opts.limit, opts.offset);
    },
    async busyIntervals(tenantId, providerId, fromIso, toIso) {
      return clone([...bookings.values()].filter((b) => b.tenant_id === tenantId && b.provider_id === providerId && liveBooking(b) && b.block_until > fromIso && b.starts_at < toIso).map((b) => ({ starts_at: b.starts_at, block_until: b.block_until })));
    },
    async updateBooking(tenantId, id, from, patch, opts) {
      const b = own(bookings, tenantId, id);
      if (!b || !from.includes(b.status)) return null;
      for (const k of opts?.requireNull ?? []) if (b[k] !== null) return null;
      const next = { ...b, ...patch, updated_at: now() };
      bookings.set(id, next);
      return clone(next);
    },
    async rescheduleBooking(tenantId, id, startIso, endIso, blockIso) {
      const b = own(bookings, tenantId, id);
      if (!b) fail("booking not found");
      if (!liveBooking(b!)) return false;
      const st = new Date(startIso).getTime();
      if (st <= Date.now()) fail("slot taken");
      if (clash(b!.provider_id, st, new Date(blockIso).getTime(), b!.id)) fail("slot taken");
      bookings.set(id, { ...b!, starts_at: new Date(startIso).toISOString(), ends_at: new Date(endIso).toISOString(), block_until: new Date(blockIso).toISOString(), reminder_sent_at: null, rescheduled_at: now(), updated_at: now() });
      return true;
    },
    async listExpiredHeldOrderIdsForProvider(tenantId, providerId, nowIso) {
      const ids = [...new Set([...bookings.values()].filter((b) => b.tenant_id === tenantId && b.provider_id === providerId && b.status === "held" && b.order_id).map((b) => b.order_id!))];
      const out: string[] = [];
      for (const id of ids) {
        const o = await root?.getOrderById(tenantId, id);
        if (o && o.status === "pending_payment" && o.expires_at && o.expires_at < nowIso) out.push(id);
      }
      return out;
    },
    async listBookingsStartingBetween(fromIso, toIso, limit) {
      return clone([...bookings.values()].filter((b) => b.status === "confirmed" && b.starts_at >= fromIso && b.starts_at < toIso).slice(0, limit));
    },

    /* ------------------------------------------------ courses */
    async insertCourse(row) {
      if ([...courses.values()].some((c) => c.tenant_id === row.tenant_id && c.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const r: CourseRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      courses.set(r.id, r);
      return clone(r);
    },
    async updateCourse(tenantId, id, patch) {
      const c = own(courses, tenantId, id);
      if (!c) return null;
      const next = { ...c, ...clone(patch), updated_at: now() };
      courses.set(id, next);
      return clone(next);
    },
    async getCourseById(tenantId, id) {
      return clone(own(courses, tenantId, id) ?? null);
    },
    async getCourseBySlug(tenantId, slug) {
      return clone([...courses.values()].find((c) => c.tenant_id === tenantId && c.slug === slug) ?? null);
    },
    async listCourses(tenantId, opts) {
      return clone([...courses.values()].filter((c) => c.tenant_id === tenantId && (!opts.status || c.status === opts.status)).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)));
    },
    async insertLesson(row) {
      if ([...lessons.values()].some((l) => l.course_id === row.course_id && l.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const r: LessonRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      lessons.set(r.id, r);
      return clone(r);
    },
    async updateLesson(tenantId, id, patch) {
      const l = own(lessons, tenantId, id);
      if (!l) return null;
      const next = { ...l, ...clone(patch), updated_at: now() };
      lessons.set(id, next);
      return clone(next);
    },
    async getLesson(tenantId, id) {
      return clone(own(lessons, tenantId, id) ?? null);
    },
    async getLessonBySlug(tenantId, courseId, slug) {
      return clone([...lessons.values()].find((l) => l.tenant_id === tenantId && l.course_id === courseId && l.slug === slug) ?? null);
    },
    async listLessons(tenantId, courseIds) {
      return clone([...lessons.values()].filter((l) => l.tenant_id === tenantId && courseIds.includes(l.course_id)).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)));
    },
    async grantEnrollment(tenantId, input) {
      const hit = [...enrollments.values()].find((e) => e.tenant_id === tenantId && e.course_id === input.courseId && e.member_id === input.memberId);
      if (hit && hit.status === "active") return { id: hit.id, granted: false };
      const base = hit ?? { id: randomUUID(), tenant_id: tenantId, course_id: input.courseId, member_id: input.memberId, created_at: now() };
      const row: EnrollmentRow = { ...base, status: "active", source: input.source, order_id: input.orderId, granted_at: now(), granted_by: input.by, revoked_at: null, revoked_by: null, revoke_reason: null, updated_at: now() } as EnrollmentRow;
      enrollments.set(row.id, row);
      return { id: row.id, granted: true };
    },
    async revokeEnrollment(tenantId, where, patch) {
      const out: EnrollmentRow[] = [];
      for (const e of enrollments.values()) {
        if (e.tenant_id !== tenantId || e.status !== "active") continue;
        if (where.id && e.id !== where.id) continue;
        if (where.orderId && e.order_id !== where.orderId) continue;
        if (where.courseId && e.course_id !== where.courseId) continue;
        if (where.memberId && e.member_id !== where.memberId) continue;
        if (!where.id && !where.orderId && !(where.courseId && where.memberId)) continue;
        const next: EnrollmentRow = { ...e, status: "revoked", revoked_at: now(), revoked_by: patch.by, revoke_reason: patch.reason, updated_at: now() };
        enrollments.set(e.id, next);
        out.push(clone(next));
      }
      return out;
    },
    async getEnrollment(tenantId, courseId, memberId) {
      return clone([...enrollments.values()].find((e) => e.tenant_id === tenantId && e.course_id === courseId && e.member_id === memberId) ?? null);
    },
    async listEnrollments(tenantId, opts) {
      const rows = [...enrollments.values()]
        .filter((e) => e.tenant_id === tenantId && (!opts.courseId || e.course_id === opts.courseId) && (!opts.memberId || e.member_id === opts.memberId) && (!opts.status || e.status === opts.status))
        .sort((a, b) => b.granted_at.localeCompare(a.granted_at));
      return page(rows, opts.limit, opts.offset);
    },
    async markLessonDone(row) {
      const k = `${row.member_id}|${row.lesson_id}`;
      if (!progress.has(k)) progress.set(k, { ...row, completed_at: now() });
    },
    async listProgress(tenantId, memberId, courseId) {
      return [...progress.values()].filter((p) => p.tenant_id === tenantId && p.member_id === memberId && p.course_id === courseId).map((p) => ({ lesson_id: p.lesson_id, completed_at: p.completed_at }));
    },

    async insertPiiLog(row) {
      pii.push({ ...clone(row), id: pii.length + 1, at: now() });
    },
    async listPiiLog(tenantId, limit) {
      return clone(pii.filter((p) => p.tenant_id === tenantId).slice().reverse().slice(0, limit));
    },
  };

  return {
    store,
    bridge,
    attach(s: Store) {
      root = s;
    },
  };
}
