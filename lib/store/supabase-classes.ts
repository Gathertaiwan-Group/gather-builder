import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import { COUPON_PER_USER, COUPON_UNAVAILABLE } from "./supabase-commerce";
import { mapCreditError } from "./supabase-content";
import { createSupabaseBookingStore } from "./supabase-booking";
import { createSupabaseCoursesStore } from "./supabase-courses";
import type {
  ClassesStore,
  HookFailureRow,
  EventRow,
  EventSessionRow,
  PiiAccessRow,
  RegistrationRow,
  TicketTypeRow,
  WaitlistRow,
} from "./types-classes";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

export { RESERVE_ERRORS } from "./reserve-errors";
import { RESERVE_ERRORS } from "./reserve-errors";

function raiseMapped(message: string, what: string): never {
  const m = /builder: ([a-z -]+)/.exec(message);
  const key = m?.[1]?.trim();
  if (key && RESERVE_ERRORS[key]) throw new ServiceError(RESERVE_ERRORS[key]!.code, RESERVE_ERRORS[key]!.message);
  if (/coupon unavailable/.test(message)) throw new ServiceError("conflict", COUPON_UNAVAILABLE);
  if (/coupon per-user limit/.test(message)) throw new ServiceError("conflict", COUPON_PER_USER);
  const credit = mapCreditError(message);
  if (credit) throw credit;
  throw new Error(`${what}: ${message}`);
}

function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    raiseMapped(r.error.message, what);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string | null | undefined) => !!s && UUID.test(s);
const nowIso = () => new Date().toISOString();


/** 第四批（events，booking／courses 另見各自檔案）的 Supabase 實作：所有查詢都帶 tenant_id */
export function createSupabaseClassesStore(db: SupabaseClient): ClassesStore {
  const page = async <T>(q: PromiseLike<{ data: unknown; error: { message: string } | null; count: number | null }>, what: string) => {
    const r = await q;
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return { rows: (r.data ?? []) as T[], total: r.count ?? 0 };
  };
  return {
    ...createSupabaseBookingStore(db),
    ...createSupabaseCoursesStore(db),
    /* -------------------------------------------------------- events */
    async insertEvent(row) {
      return must(await db.from("builder_events").insert(row).select("*").single(), "insertEvent") as EventRow;
    },
    async updateEvent(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_events").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateEvent") as EventRow | null;
    },
    async getEventById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_events").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getEventById") as EventRow | null;
    },
    async getEventBySlug(tenantId, slug) {
      return must(await db.from("builder_events").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getEventBySlug") as EventRow | null;
    },
    async listEvents(tenantId, opts) {
      let q = db.from("builder_events").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return page<EventRow>(q.order("sort").order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1), "listEvents");
    },
    async insertSession(row) {
      return must(await db.from("builder_event_sessions").insert(row).select("*").single(), "insertSession") as EventSessionRow;
    },
    async updateSession(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_sessions").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateSession") as EventSessionRow | null;
    },
    async getSession(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_sessions").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getSession") as EventSessionRow | null;
    },
    async listSessions(tenantId, eventIds) {
      const ids = eventIds.filter(isUuid);
      if (!ids.length) return [];
      return (must(await db.from("builder_event_sessions").select("*").eq("tenant_id", tenantId).in("event_id", ids).order("starts_at"), "listSessions") ?? []) as EventSessionRow[];
    },
    async listSessionsStartingBetween(fromIso, toIso, limit) {
      return (must(await db.from("builder_event_sessions").select("*").eq("status", "scheduled").gte("starts_at", fromIso).lt("starts_at", toIso).order("starts_at").limit(limit), "listSessionsStartingBetween") ?? []) as EventSessionRow[];
    },
    async listSessionsWithWaitlist(limit) {
      const w = (must(await db.from("builder_event_waitlist").select("session_id").in("status", ["waiting", "offered"]).limit(2000), "listSessionsWithWaitlist.w") ?? []) as { session_id: string }[];
      const ids = [...new Set(w.map((x) => x.session_id))].slice(0, 500);
      if (!ids.length) return [];
      return (must(await db.from("builder_event_sessions").select("id, tenant_id").in("id", ids).gt("starts_at", nowIso()).limit(limit), "listSessionsWithWaitlist") ?? []) as Pick<EventSessionRow, "id" | "tenant_id">[];
    },
    async insertTicketType(row) {
      return must(await db.from("builder_event_ticket_types").insert(row).select("*").single(), "insertTicketType") as TicketTypeRow;
    },
    async updateTicketType(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_ticket_types").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateTicketType") as TicketTypeRow | null;
    },
    async getTicketType(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_ticket_types").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getTicketType") as TicketTypeRow | null;
    },
    async listTicketTypes(tenantId, sessionIds) {
      const ids = sessionIds.filter(isUuid);
      if (!ids.length) return [];
      return (must(await db.from("builder_event_ticket_types").select("*").eq("tenant_id", tenantId).in("session_id", ids).order("sort").order("price"), "listTicketTypes") ?? []) as TicketTypeRow[];
    },
    async reserveEventFree(tenantId, res) {
      const r = await db.rpc("builder_reserve_event", { p_tenant: tenantId, p_order: null, p_res: res });
      if (r.error) {
        if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複");
        raiseMapped(r.error.message, "reserveEventFree");
      }
      return r.data as string;
    },
    async getRegistration(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_registrations").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getRegistration") as RegistrationRow | null;
    },
    async getRegistrationByCheckinHash(tenantId, hash) {
      return must(await db.from("builder_event_registrations").select("*").eq("tenant_id", tenantId).eq("checkin_code_hash", hash).maybeSingle(), "getRegistrationByCheckinHash") as RegistrationRow | null;
    },
    async listRegistrations(tenantId, opts) {
      let q = db.from("builder_event_registrations").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.sessionId) q = q.eq("session_id", opts.sessionId);
      if (opts.eventId) q = q.eq("event_id", opts.eventId);
      if (opts.orderId) q = q.eq("order_id", opts.orderId);
      if (opts.memberId) q = q.eq("member_id", opts.memberId);
      if (opts.status) q = q.in("status", opts.status);
      return page<RegistrationRow>(q.order("created_at").range(opts.offset, opts.offset + opts.limit - 1), "listRegistrations");
    },
    async updateRegistration(tenantId, id, from, patch, opts) {
      if (!isUuid(id)) return null;
      let q = db.from("builder_event_registrations").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from);
      for (const k of opts?.requireNull ?? []) q = q.is(k, null);
      return must(await q.select("*").maybeSingle(), "updateRegistration") as RegistrationRow | null;
    },
    async sessionUsage(tenantId, sessionId) {
      const [regs, wl] = await Promise.all([
        db.from("builder_event_registrations").select("ticket_type_id, qty, order_id, hold_expires_at").eq("tenant_id", tenantId).eq("session_id", sessionId).in("status", ["held", "confirmed"]),
        db.from("builder_event_waitlist").select("ticket_type_id, qty, status, offer_expires_at").eq("tenant_id", tenantId).eq("session_id", sessionId).in("status", ["waiting", "offered"]),
      ]);
      if (regs.error || wl.error) throw new Error(`sessionUsage: ${(regs.error ?? wl.error)!.message}`);
      const byTicket: Record<string, number> = {};
      let taken = 0;
      let offered = 0;
      let waiting = 0;
      const t0 = Date.now();
      for (const r of (regs.data ?? []) as { ticket_type_id: string; qty: number; order_id: string | null; hold_expires_at: string | null }[]) {
        // 逾期未確認 email 的免費保留不算（下次報名／遞補時 SQL 會標 expired）
        if (!r.order_id && r.hold_expires_at && new Date(r.hold_expires_at).getTime() <= t0) continue;
        taken += r.qty;
        byTicket[r.ticket_type_id] = (byTicket[r.ticket_type_id] ?? 0) + r.qty;
      }
      const t = Date.now();
      for (const w of (wl.data ?? []) as { ticket_type_id: string; qty: number; status: string; offer_expires_at: string | null }[]) {
        if (w.status === "waiting") waiting++;
        else if (w.offer_expires_at && new Date(w.offer_expires_at).getTime() > t) {
          offered += w.qty;
          byTicket[w.ticket_type_id] = (byTicket[w.ticket_type_id] ?? 0) + w.qty;
        }
      }
      return { taken, offered, byTicket, waiting };
    },
    async listExpiredHeldOrderIdsForSession(tenantId, sessionId, now) {
      const held = (must(await db.from("builder_event_registrations").select("order_id").eq("tenant_id", tenantId).eq("session_id", sessionId).eq("status", "held").not("order_id", "is", null).limit(500), "listExpiredHeld.regs") ?? []) as { order_id: string }[];
      const ids = [...new Set(held.map((h) => h.order_id))];
      if (!ids.length) return [];
      const due = (must(await db.from("builder_orders").select("id").eq("tenant_id", tenantId).in("id", ids).eq("status", "pending_payment").lt("expires_at", now).limit(50), "listExpiredHeld.orders") ?? []) as { id: string }[];
      return due.map((d) => d.id);
    },
    async insertWaitlist(row) {
      const r = await db.from("builder_event_waitlist").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertWaitlist") as WaitlistRow;
    },
    async getWaitlist(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_waitlist").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getWaitlist") as WaitlistRow | null;
    },
    async listWaitlist(tenantId, sessionId) {
      return (must(await db.from("builder_event_waitlist").select("*").eq("tenant_id", tenantId).eq("session_id", sessionId).order("created_at").order("id"), "listWaitlist") ?? []) as WaitlistRow[];
    },
    async updateWaitlist(tenantId, id, from, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_event_waitlist").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from).select("*").maybeSingle(), "updateWaitlist") as WaitlistRow | null;
    },
    async offerWaitlist(tenantId, sessionId, hours) {
      return (must(await db.rpc("builder_offer_waitlist", { p_tenant: tenantId, p_session: sessionId, p_hours: hours }), "offerWaitlist") ?? []) as WaitlistRow[];
    },
    async insertPiiLog(row) {
      must(await db.from("builder_pii_access_log").insert(row), "insertPiiLog");
    },
    async recordHookFailure(row) {
      const cur = must(await db.from("builder_hook_failures").select("id, attempts, resolved_at").eq("order_id", row.order_id).eq("hook", row.hook).eq("event", row.event).maybeSingle(), "recordHookFailure.get") as { id: string; attempts: number; resolved_at: string | null } | null;
      if (!cur) {
        const r = await db.from("builder_hook_failures").insert({ tenant_id: row.tenant_id, order_id: row.order_id, hook: row.hook, event: row.event, last_error: row.error });
        if (!r.error) return;
        if (r.error.code !== "23505") throw new Error(`recordHookFailure: ${r.error.message}`);
        // 併發另一個失敗剛寫入：改成累加
        must(await db.from("builder_hook_failures").update({ last_error: row.error, last_attempt_at: nowIso() }).eq("order_id", row.order_id).eq("hook", row.hook).eq("event", row.event), "recordHookFailure.race");
        return;
      }
      must(await db.from("builder_hook_failures").update({ attempts: cur.resolved_at ? 1 : cur.attempts + 1, last_error: row.error, last_attempt_at: nowIso(), resolved_at: null, alerted_at: cur.resolved_at ? null : undefined }).eq("id", cur.id), "recordHookFailure.update");
    },
    async listOpenHookFailures(opts) {
      let q = db.from("builder_hook_failures").select("*").is("resolved_at", null).lt("attempts", opts.maxAttempts);
      if (opts.orderId) {
        if (!isUuid(opts.orderId)) return [];
        q = q.eq("order_id", opts.orderId);
      }
      if (opts.tenantId) q = q.eq("tenant_id", opts.tenantId);
      return (must(await q.order("last_attempt_at").limit(opts.limit), "listOpenHookFailures") ?? []) as HookFailureRow[];
    },
    async resolveHookFailure(id, how) {
      must(await db.from("builder_hook_failures").update({ resolved_at: nowIso(), last_error: how === "obsolete" ? "obsolete" : undefined }).eq("id", id).is("resolved_at", null), "resolveHookFailure");
    },
    async bumpHookFailure(id, error) {
      const cur = must(await db.from("builder_hook_failures").select("attempts").eq("id", id).single(), "bumpHookFailure.get") as { attempts: number };
      const next = cur.attempts + 1;
      must(await db.from("builder_hook_failures").update({ attempts: next, last_error: error, last_attempt_at: nowIso() }).eq("id", id), "bumpHookFailure");
      return next;
    },
    async markHookFailureAlerted(id) {
      const rows = must(await db.from("builder_hook_failures").update({ alerted_at: nowIso() }).eq("id", id).is("alerted_at", null).select("id"), "markHookFailureAlerted") as { id: string }[];
      return rows.length > 0;
    },
    async listPiiLog(tenantId, limit) {
      return (must(await db.from("builder_pii_access_log").select("*").eq("tenant_id", tenantId).order("id", { ascending: false }).limit(limit), "listPiiLog") ?? []) as PiiAccessRow[];
    },

    /* -------------------------------------------------------- 課程類訂單 */
    async placeClassOrder(tenantId, order, items, day, res) {
      const r = await db.rpc("builder_place_class_order", { p_tenant: tenantId, p_order: order, p_items: items, p_day: day, p_res: res });
      if (r.error) {
        if (r.error.code === "23505") throw new ServiceError("conflict", "這個時段剛被預約走了，請選擇其他時段");
        raiseMapped(r.error.message, "placeClassOrder");
      }
      const row = (r.data as { order_id: string; order_no: string; reservation_id: string | null }[])[0]!;
      return { id: row.order_id, order_no: row.order_no, reservation_id: row.reservation_id };
    },
  };
}
