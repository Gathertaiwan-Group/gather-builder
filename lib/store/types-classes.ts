/**
 * 第四批（events／booking／courses）的資料列與 Store 方法。
 * 「課程類」品項都走既有訂單（builder_orders）：品項 item_kind ≠ product、沒有商品庫存，
 * 改成在 builder_place_class_order 同一交易內做名額預留；取消／逾期由 builder_cancel_order 同一交易釋放。
 */
import type { OrderContact, OrderShipping, PaymentMethod, InvoiceRequest } from "./types";

export type ClassItemKind = "event_ticket" | "booking" | "course";

/* ------------------------------------------------------------------ events */

export type EventStatus = "draft" | "published" | "cancelled";
export type LocationType = "physical" | "online" | "hybrid";

export interface EventRow {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  summary: string | null;
  body_md: string;
  cover_url: string | null;
  location_type: LocationType;
  location: string | null;
  online_url: string | null;
  status: EventStatus;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface EventSessionRow {
  id: string;
  tenant_id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  capacity: number;
  offline_seats: number;
  status: "scheduled" | "cancelled";
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketTypeRow {
  id: string;
  tenant_id: string;
  event_id: string;
  session_id: string;
  name: string;
  price: number;
  max_per_order: number;
  sales_start: string | null;
  sales_end: string | null;
  quota: number | null;
  active: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

export type RegistrationStatus = "held" | "confirmed" | "cancelled" | "expired";

export interface RegistrationRow {
  id: string;
  tenant_id: string;
  event_id: string;
  session_id: string;
  ticket_type_id: string;
  order_id: string | null;
  member_id: string | null;
  qty: number;
  unit_price: number;
  contact: OrderContact;
  status: RegistrationStatus;
  source: "online" | "waitlist";
  checkin_code_hash: string | null;
  checked_in_at: string | null;
  checked_in_by: string | null;
  reminder_sent_at: string | null;
  refund_required: boolean;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type WaitlistStatus = "waiting" | "offered" | "claimed" | "lapsed" | "cancelled";

export interface WaitlistRow {
  id: string;
  tenant_id: string;
  session_id: string;
  ticket_type_id: string;
  member_id: string | null;
  contact: OrderContact;
  email_norm: string;
  qty: number;
  status: WaitlistStatus;
  offered_at: string | null;
  offer_expires_at: string | null;
  claimed_registration_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PiiAccessRow {
  id: number;
  tenant_id: string;
  actor: string;
  action: "reveal" | "export";
  subject_type: string;
  subject_id: string | null;
  detail: Record<string, unknown> | null;
  at: string;
}

/** 報名預留（builder_reserve_event 的 p_res） */
export interface EventReservation {
  session_id: string;
  ticket_type_id: string;
  qty: number;
  unit_price: number;
  contact: OrderContact;
  member_id: string | null;
  offer_id?: string | null;
  checkin_code_hash?: string | null;
}

export type ClassReservation = { kind: "event"; data: EventReservation } | { kind: "booking"; data: BookingReservation } | null;

/** 課程類訂單（builder_place_class_order 的 p_order） */
export interface ClassOrderInput {
  order_prefix: string;
  member_id: string | null;
  contact: OrderContact;
  shipping: OrderShipping;
  subtotal: number;
  total: number;
  payment_method: PaymentMethod;
  expires_at: string;
  access_key_hash: string;
  note: string | null;
  discount_total?: number;
  coupon?: { id: string; code: string; user_key: string } | null;
  referral_code?: string | null;
  invoice_request?: InvoiceRequest | null;
}

export interface ClassOrderItem {
  item_kind: ClassItemKind;
  ref_id: string;
  name: string;
  variant_label: string | null;
  sku: string | null;
  unit_price: number;
  qty: number;
  line_total: number;
}

/** 場次用量（即時由報名列加總，不是計數欄位） */
export interface SessionUsage {
  /** held＋confirmed 的人數 */
  taken: number;
  /** 有效候補保留 */
  offered: number;
  /** 依票種：held＋confirmed＋有效保留 */
  byTicket: Record<string, number>;
  waiting: number;
}

/* ------------------------------------------------------------------ booking（第二個模組補上） */

export interface BookingReservation {
  provider_id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  block_until: string;
  price: number;
  amount_due: number;
  contact: OrderContact;
  member_id: string | null;
  note: string | null;
}

/* ------------------------------------------------------------------ Store 方法 */

export interface ClassesStore {
  // events
  insertEvent(row: Omit<EventRow, "id" | "created_at" | "updated_at">): Promise<EventRow>;
  updateEvent(tenantId: string, id: string, patch: Partial<Omit<EventRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<EventRow | null>;
  getEventById(tenantId: string, id: string): Promise<EventRow | null>;
  getEventBySlug(tenantId: string, slug: string): Promise<EventRow | null>;
  listEvents(tenantId: string, opts: { status?: EventStatus; limit: number; offset: number }): Promise<{ rows: EventRow[]; total: number }>;
  insertSession(row: Omit<EventSessionRow, "id" | "created_at" | "updated_at" | "cancelled_at" | "cancel_reason" | "status"> & { status?: EventSessionRow["status"] }): Promise<EventSessionRow>;
  updateSession(tenantId: string, id: string, patch: Partial<Pick<EventSessionRow, "starts_at" | "ends_at" | "capacity" | "offline_seats" | "status" | "cancelled_at" | "cancel_reason">>): Promise<EventSessionRow | null>;
  getSession(tenantId: string, id: string): Promise<EventSessionRow | null>;
  listSessions(tenantId: string, eventIds: string[]): Promise<EventSessionRow[]>;
  /** 所有租戶：開始時間在 [fromIso, toIso) 的場次（提醒 cron 用） */
  listSessionsStartingBetween(fromIso: string, toIso: string, limit: number): Promise<EventSessionRow[]>;
  /** 所有租戶：有候補（waiting／offered）的未來場次（cron 遞補用） */
  listSessionsWithWaitlist(limit: number): Promise<Pick<EventSessionRow, "id" | "tenant_id">[]>;
  insertTicketType(row: Omit<TicketTypeRow, "id" | "created_at" | "updated_at">): Promise<TicketTypeRow>;
  updateTicketType(tenantId: string, id: string, patch: Partial<Pick<TicketTypeRow, "name" | "price" | "max_per_order" | "sales_start" | "sales_end" | "quota" | "active" | "sort">>): Promise<TicketTypeRow | null>;
  getTicketType(tenantId: string, id: string): Promise<TicketTypeRow | null>;
  listTicketTypes(tenantId: string, sessionIds: string[]): Promise<TicketTypeRow[]>;
  /** 免費票：原子扣名額（builder_reserve_event，order=null → confirmed）。名額不足等丟 ServiceError(conflict／invalid) */
  reserveEventFree(tenantId: string, res: EventReservation): Promise<string>;
  getRegistration(tenantId: string, id: string): Promise<RegistrationRow | null>;
  getRegistrationByCheckinHash(tenantId: string, hash: string): Promise<RegistrationRow | null>;
  listRegistrations(tenantId: string, opts: { sessionId?: string; eventId?: string; orderId?: string; memberId?: string; status?: RegistrationStatus[]; limit: number; offset: number }): Promise<{ rows: RegistrationRow[]; total: number }>;
  /** 條件式更新（目前狀態 ∈ from 才寫；patch 可帶 checked_in_at 時要求原本為 null） */
  updateRegistration(tenantId: string, id: string, from: RegistrationStatus[], patch: Partial<Pick<RegistrationRow, "status" | "checkin_code_hash" | "checked_in_at" | "checked_in_by" | "reminder_sent_at" | "refund_required" | "cancelled_at" | "cancel_reason">>, opts?: { requireNull?: ("checked_in_at" | "reminder_sent_at")[] }): Promise<RegistrationRow | null>;
  sessionUsage(tenantId: string, sessionId: string): Promise<SessionUsage>;
  /** 某場次：報名仍是 held、訂單 pending 且已逾期（下單前先釋放逾期保留用） */
  listExpiredHeldOrderIdsForSession(tenantId: string, sessionId: string, nowIso: string): Promise<string[]>;
  /** 同場次同 email 已在候補中回 null */
  insertWaitlist(row: Pick<WaitlistRow, "tenant_id" | "session_id" | "ticket_type_id" | "member_id" | "contact" | "email_norm" | "qty">): Promise<WaitlistRow | null>;
  getWaitlist(tenantId: string, id: string): Promise<WaitlistRow | null>;
  listWaitlist(tenantId: string, sessionId: string): Promise<WaitlistRow[]>;
  updateWaitlist(tenantId: string, id: string, from: WaitlistStatus[], patch: Partial<Pick<WaitlistRow, "status">>): Promise<WaitlistRow | null>;
  /** builder_offer_waitlist：過期保留 lapsed、依序給出新保留，回傳新給出的 */
  offerWaitlist(tenantId: string, sessionId: string, hours: number): Promise<WaitlistRow[]>;
  insertPiiLog(row: Omit<PiiAccessRow, "id" | "at">): Promise<void>;
  listPiiLog(tenantId: string, limit: number): Promise<PiiAccessRow[]>;

  // 課程類訂單（活動票／預約／課程）
  /** builder_place_class_order：訂單＋品項＋優惠券＋名額預留在同一交易；任一失敗整筆不成立 */
  placeClassOrder(tenantId: string, order: ClassOrderInput, items: ClassOrderItem[], day: string, res: ClassReservation): Promise<{ id: string; order_no: string; reservation_id: string | null }>;
}
