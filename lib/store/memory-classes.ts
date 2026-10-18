import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { ReservationBridge } from "./memory-commerce";
import type {
  ClassesStore,
  ClassReservation,
  EventReservation,
  EventRow,
  EventSessionRow,
  PiiAccessRow,
  RegistrationRow,
  Store,
  TicketTypeRow,
  WaitlistRow,
} from "./types";
import { RESERVE_ERRORS } from "./supabase-classes";

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
  const pii: PiiAccessRow[] = [];
  let root: Store | null = null;

  const fail = (code: string): never => {
    const e = RESERVE_ERRORS[code]!;
    throw new ServiceError(e.code, e.message);
  };
  const activeOffer = (w: WaitlistRow, t = Date.now()) => w.status === "offered" && !!w.offer_expires_at && new Date(w.offer_expires_at).getTime() > t;
  const usedSeats = (s: EventSessionRow) =>
    [...regs.values()].filter((r) => r.session_id === s.id && (r.status === "held" || r.status === "confirmed")).reduce((n, r) => n + r.qty, 0) +
    s.offline_seats +
    [...waitlist.values()].filter((w) => w.session_id === s.id && activeOffer(w)).reduce((n, w) => n + w.qty, 0);
  const usedTicket = (t: TicketTypeRow) =>
    [...regs.values()].filter((r) => r.ticket_type_id === t.id && (r.status === "held" || r.status === "confirmed")).reduce((n, r) => n + r.qty, 0) +
    [...waitlist.values()].filter((w) => w.ticket_type_id === t.id && activeOffer(w)).reduce((n, w) => n + w.qty, 0);

  function reserveEventSync(tenantId: string, orderId: string | null, res: EventReservation): string {
    const s = sessions.get(res.session_id);
    if (!s || s.tenant_id !== tenantId) fail("session not found");
    const ev = events.get(s!.event_id);
    if (s!.status !== "scheduled" || ev?.status !== "published") fail("session closed");
    if (new Date(s!.starts_at).getTime() <= Date.now()) fail("session started");
    const t = tickets.get(res.ticket_type_id);
    if (!t || t.session_id !== s!.id || t.tenant_id !== tenantId || !t.active) fail("ticket unavailable");
    const nowMs = Date.now();
    if ((t!.sales_start && new Date(t!.sales_start).getTime() > nowMs) || (t!.sales_end && new Date(t!.sales_end).getTime() <= nowMs)) fail("ticket not on sale");
    if (!Number.isInteger(res.qty) || res.qty < 1 || res.qty > t!.max_per_order) fail("qty limit");
    if (res.unit_price !== t!.price) fail("price changed");
    let offer: WaitlistRow | undefined;
    if (res.offer_id) {
      offer = waitlist.get(res.offer_id);
      if (!offer || offer.tenant_id !== tenantId || offer.session_id !== s!.id || offer.ticket_type_id !== t!.id || !activeOffer(offer)) fail("offer invalid");
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
      status: orderId ? "held" : "confirmed",
      source: offer ? "waitlist" : "online",
      checkin_code_hash: res.checkin_code_hash || null,
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
  const bookingBridge: { reserve: (tenantId: string, orderId: string, res: NonNullable<ClassReservation>) => string; release: (tenantId: string, orderId: string, reason: string) => void } = {
    reserve: () => {
      throw new Error("builder: unknown reservation kind");
    },
    release: () => undefined,
  };

  const page = <T>(rows: T[], limit: number, offset: number) => ({ rows: clone(rows.slice(offset, offset + limit)), total: rows.length });
  const own = <T extends { tenant_id: string }>(m: Map<string, T>, tenantId: string, id: string) => {
    const r = m.get(id);
    return r && r.tenant_id === tenantId ? r : undefined;
  };

  const store: MemoryClasses = {
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
      const live = [...regs.values()].filter((r) => r.tenant_id === tenantId && r.session_id === sessionId && (r.status === "held" || r.status === "confirmed"));
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
      if ([...waitlist.values()].some((w) => w.session_id === row.session_id && w.email_norm === row.email_norm && (w.status === "waiting" || w.status === "offered"))) return null;
      const r: WaitlistRow = { ...clone(row), id: randomUUID(), status: "waiting", offered_at: null, offer_expires_at: null, claimed_registration_id: null, created_at: now(), updated_at: now() };
      waitlist.set(r.id, r);
      return clone(r);
    },
    async getWaitlist(tenantId, id) {
      return clone(own(waitlist, tenantId, id) ?? null);
    },
    async listWaitlist(tenantId, sessionId) {
      return clone([...waitlist.values()].filter((w) => w.tenant_id === tenantId && w.session_id === sessionId).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
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
      const t = Date.now();
      for (const w of waitlist.values()) {
        if (w.session_id === s.id && w.status === "offered" && (!w.offer_expires_at || new Date(w.offer_expires_at).getTime() <= t)) waitlist.set(w.id, { ...w, status: "lapsed", updated_at: now() });
      }
      const ev = events.get(s.event_id);
      if (s.status !== "scheduled" || ev?.status !== "published" || new Date(s.starts_at).getTime() <= t) return [];
      const until = new Date(Math.min(t + Math.max(1, Math.min(hours, 168)) * 3600_000, new Date(s.starts_at).getTime())).toISOString();
      const out: WaitlistRow[] = [];
      for (;;) {
        const w = [...waitlist.values()].filter((x) => x.session_id === s.id && x.status === "waiting").sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))[0];
        if (!w) break;
        if (usedSeats(s) + w.qty > s.capacity) break;
        const tt = tickets.get(w.ticket_type_id);
        if (tt && tt.quota !== null && usedTicket(tt) + w.qty > tt.quota) break;
        const next: WaitlistRow = { ...w, status: "offered", offered_at: now(), offer_expires_at: until, updated_at: now() };
        waitlist.set(w.id, next);
        out.push(clone(next));
      }
      return out;
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
