import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import { RESERVE_ERRORS } from "./reserve-errors";
import type { BookingRow, ClassesStore, HoursRow, OverrideRow, ProviderRow, ServiceRow } from "./types-classes";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type BookingKeys =
  | "insertProvider" | "listProviders" | "getProvider" | "insertService" | "updateService" | "getServiceById" | "getServiceBySlug" | "listServices"
  | "replaceWeeklyHours" | "listWeeklyHours" | "insertOverride" | "listOverrides" | "reserveBookingFree" | "getBooking" | "listBookings" | "busyIntervals"
  | "updateBooking" | "rescheduleBooking" | "listExpiredHeldOrderIdsForProvider" | "listBookingsStartingBetween";

function raise(message: string, what: string): never {
  const key = /builder: ([a-z -]+)/.exec(message)?.[1]?.trim();
  if (key && RESERVE_ERRORS[key]) throw new ServiceError(RESERVE_ERRORS[key]!.code, RESERVE_ERRORS[key]!.message);
  throw new Error(`${what}: ${message}`);
}
function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    raise(r.error.message, what);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string | null | undefined) => !!s && UUID.test(s);
const nowIso = () => new Date().toISOString();

/** booking 的 Supabase 實作（所有查詢都帶 tenant_id） */
export function createSupabaseBookingStore(db: SupabaseClient): Pick<ClassesStore, BookingKeys> {
  return {
    async insertProvider(row) {
      return must(await db.from("builder_booking_providers").insert(row).select("*").single(), "insertProvider") as ProviderRow;
    },
    async listProviders(tenantId) {
      return (must(await db.from("builder_booking_providers").select("*").eq("tenant_id", tenantId).order("sort").order("created_at"), "listProviders") ?? []) as ProviderRow[];
    },
    async getProvider(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_booking_providers").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getProvider") as ProviderRow | null;
    },
    async insertService(row) {
      return must(await db.from("builder_booking_services").insert(row).select("*").single(), "insertService") as ServiceRow;
    },
    async updateService(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_booking_services").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateService") as ServiceRow | null;
    },
    async getServiceById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_booking_services").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getServiceById") as ServiceRow | null;
    },
    async getServiceBySlug(tenantId, slug) {
      return must(await db.from("builder_booking_services").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getServiceBySlug") as ServiceRow | null;
    },
    async listServices(tenantId, opts) {
      let q = db.from("builder_booking_services").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return (must(await q.order("sort").order("created_at"), "listServices") ?? []) as ServiceRow[];
    },
    async replaceWeeklyHours(tenantId, providerId, rows) {
      // 先刪後插（兩個請求）：期間讀到空時段只會讓「可預約時段」暫時變少，不會造成重複預約（衝突由 builder_reserve_booking 保證）
      must(await db.from("builder_booking_hours").delete().eq("tenant_id", tenantId).eq("provider_id", providerId), "replaceWeeklyHours.delete");
      if (!rows.length) return [];
      return (must(await db.from("builder_booking_hours").insert(rows.map((r) => ({ ...r, tenant_id: tenantId, provider_id: providerId }))).select("*"), "replaceWeeklyHours.insert") ?? []) as HoursRow[];
    },
    async listWeeklyHours(tenantId, providerId) {
      return (must(await db.from("builder_booking_hours").select("*").eq("tenant_id", tenantId).eq("provider_id", providerId).order("weekday").order("start_min"), "listWeeklyHours") ?? []) as HoursRow[];
    },
    async insertOverride(row) {
      return must(await db.from("builder_booking_overrides").insert(row).select("*").single(), "insertOverride") as OverrideRow;
    },
    async listOverrides(tenantId, providerId, fromDate, toDate) {
      return (must(await db.from("builder_booking_overrides").select("*").eq("tenant_id", tenantId).eq("provider_id", providerId).gte("date", fromDate).lte("date", toDate).order("date"), "listOverrides") ?? []) as OverrideRow[];
    },
    async reserveBookingFree(tenantId, res) {
      const r = await db.rpc("builder_reserve_booking", { p_tenant: tenantId, p_order: null, p_res: res });
      if (r.error) {
        // partial unique index（同一提供者同一開始時間）＝第二道防線
        if (r.error.code === "23505") throw new ServiceError("conflict", RESERVE_ERRORS["slot taken"]!.message);
        raise(r.error.message, "reserveBookingFree");
      }
      return r.data as string;
    },
    async getBooking(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_bookings").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getBooking") as BookingRow | null;
    },
    async listBookings(tenantId, opts) {
      let q = db.from("builder_bookings").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.providerId) q = q.eq("provider_id", opts.providerId);
      if (opts.fromIso) q = q.gte("starts_at", opts.fromIso);
      if (opts.toIso) q = q.lt("starts_at", opts.toIso);
      if (opts.status) q = q.in("status", opts.status);
      if (opts.orderId) q = q.eq("order_id", opts.orderId);
      if (opts.memberId) q = q.eq("member_id", opts.memberId);
      const r = await q.order("starts_at").range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listBookings: ${r.error.message}`);
      return { rows: (r.data ?? []) as BookingRow[], total: r.count ?? 0 };
    },
    async busyIntervals(tenantId, providerId, fromIso, toIso) {
      return (must(await db.from("builder_bookings").select("starts_at, block_until").eq("tenant_id", tenantId).eq("provider_id", providerId).in("status", ["held", "confirmed"]).gt("block_until", fromIso).lt("starts_at", toIso).limit(2000), "busyIntervals") ?? []) as Pick<BookingRow, "starts_at" | "block_until">[];
    },
    async updateBooking(tenantId, id, from, patch, opts) {
      if (!isUuid(id)) return null;
      let q = db.from("builder_bookings").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from);
      for (const k of opts?.requireNull ?? []) q = q.is(k, null);
      return must(await q.select("*").maybeSingle(), "updateBooking") as BookingRow | null;
    },
    async rescheduleBooking(tenantId, id, startIso, endIso, blockIso) {
      const r = await db.rpc("builder_reschedule_booking", { p_tenant: tenantId, p_booking: id, p_start: startIso, p_end: endIso, p_block: blockIso });
      if (r.error) {
        if (r.error.code === "23505") throw new ServiceError("conflict", RESERVE_ERRORS["slot taken"]!.message);
        raise(r.error.message, "rescheduleBooking");
      }
      return r.data === true;
    },
    async listExpiredHeldOrderIdsForProvider(tenantId, providerId, now) {
      const held = (must(await db.from("builder_bookings").select("order_id").eq("tenant_id", tenantId).eq("provider_id", providerId).eq("status", "held").not("order_id", "is", null).limit(500), "expiredHeld.bookings") ?? []) as { order_id: string }[];
      const ids = [...new Set(held.map((h) => h.order_id))];
      if (!ids.length) return [];
      const due = (must(await db.from("builder_orders").select("id").eq("tenant_id", tenantId).in("id", ids).eq("status", "pending_payment").lt("expires_at", now).limit(50), "expiredHeld.orders") ?? []) as { id: string }[];
      return due.map((d) => d.id);
    },
    async listBookingsStartingBetween(fromIso, toIso, limit) {
      return (must(await db.from("builder_bookings").select("*").eq("status", "confirmed").gte("starts_at", fromIso).lt("starts_at", toIso).order("starts_at").limit(limit), "listBookingsStartingBetween") ?? []) as BookingRow[];
    },
  };
}
