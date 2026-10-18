/**
 * 第四批（events／booking／courses）的資料列與 Store 方法。
 * 「課程類」品項都走既有訂單（builder_orders）：品項 item_kind ≠ product、沒有商品庫存，
 * 改成在 builder_place_class_order 同一交易內做名額預留；取消／逾期由 builder_cancel_order 同一交易釋放。
 */
import type { OrderContact, OrderShipping, PaymentMethod, InvoiceRequest } from "./types";

export type ClassItemKind = "event_ticket" | "booking" | "course" | "topup";

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

/** 付款／取消 hook 失敗紀錄（M2：cron 與讀取時補做） */
export interface HookFailureRow {
  id: string;
  tenant_id: string;
  order_id: string;
  hook: string;
  event: "paid" | "cancelled";
  attempts: number;
  last_error: string | null;
  first_failed_at: string;
  last_attempt_at: string;
  resolved_at: string | null;
  alerted_at: string | null;
}

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
  /** 正規化 email（每 email 每場次一筆有效報名） */
  email_norm?: string | null;
  /** 免費報名待 email 確認：held＋這個期限（逾期視為失效）；付費保留為 null（由訂單逾期控制） */
  hold_expires_at?: string | null;
  email_confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type WaitlistStatus = "unconfirmed" | "waiting" | "offered" | "claimed" | "lapsed" | "cancelled";

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
  /** status=unconfirmed 時：email 確認期限 */
  confirm_expires_at?: string | null;
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
  /** 正規化 email：每 email 每場次一筆、候補認領比對 */
  email_norm?: string | null;
  /** 免費報名待 email 確認（held＋pending_minutes 分鐘） */
  pending_email?: boolean;
  pending_minutes?: number;
  /** 審查 M6：這個場次「未確認保留」最多幾筆（超過 → builder: pending cap） */
  pending_cap?: number;
}

export type ClassReservation = { kind: "event"; data: EventReservation } | { kind: "booking"; data: BookingReservation } | null;

/** 課程類訂單（builder_place_class_order 的 p_order） */
export type ClassOrderInput = import("./types").OrderCreditsInput & {
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
  /** 下單時的方案快照（例如儲值方案的金額／贈送／贈送到期天數；存在訂單 items jsonb，入帳讀快照不讀現行方案） */
  snapshot?: Record<string, unknown>;
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

export interface ProviderRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  active: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

export type PaymentMode = "none" | "deposit" | "full";

export interface ServiceRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description_md: string;
  duration_min: number;
  buffer_min: number;
  price: number;
  payment_mode: PaymentMode;
  deposit_amount: number | null;
  status: "draft" | "published";
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface HoursRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  weekday: number;
  start_min: number;
  end_min: number;
}

export interface OverrideRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  date: string;
  kind: "closed" | "open";
  start_min: number | null;
  end_min: number | null;
  note: string | null;
  created_at: string;
}

export type BookingStatus = "held" | "confirmed" | "cancelled" | "expired";

export interface BookingRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  service_id: string;
  order_id: string | null;
  member_id: string | null;
  contact: OrderContact;
  starts_at: string;
  ends_at: string;
  block_until: string;
  status: BookingStatus;
  price: number;
  amount_due: number;
  note: string | null;
  reminder_sent_at: string | null;
  refund_required: boolean;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  rescheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ courses */

export interface CourseRow {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  summary: string | null;
  body_md: string;
  cover_url: string | null;
  price: number;
  status: "draft" | "published";
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface LessonAttachment {
  name: string;
  url: string;
}

export interface LessonRow {
  id: string;
  tenant_id: string;
  course_id: string;
  slug: string;
  title: string;
  video_url: string | null;
  body_md: string;
  attachments: LessonAttachment[];
  is_preview: boolean;
  status: "draft" | "published";
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface EnrollmentRow {
  id: string;
  tenant_id: string;
  course_id: string;
  member_id: string;
  status: "active" | "revoked";
  source: "order" | "manual" | "free";
  order_id: string | null;
  granted_at: string;
  granted_by: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  created_at: string;
  updated_at: string;
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
  updateRegistration(tenantId: string, id: string, from: RegistrationStatus[], patch: Partial<Pick<RegistrationRow, "status" | "checkin_code_hash" | "checked_in_at" | "checked_in_by" | "reminder_sent_at" | "refund_required" | "cancelled_at" | "cancel_reason" | "hold_expires_at" | "email_confirmed_at">>, opts?: { requireNull?: ("checked_in_at" | "reminder_sent_at")[] }): Promise<RegistrationRow | null>;
  sessionUsage(tenantId: string, sessionId: string): Promise<SessionUsage>;
  /** 某場次：報名仍是 held、訂單 pending 且已逾期（下單前先釋放逾期保留用） */
  listExpiredHeldOrderIdsForSession(tenantId: string, sessionId: string, nowIso: string): Promise<string[]>;
  /** 同場次同 email 已在候補中回 null */
  insertWaitlist(row: Pick<WaitlistRow, "tenant_id" | "session_id" | "ticket_type_id" | "member_id" | "contact" | "email_norm" | "qty"> & { status?: "unconfirmed" | "waiting"; confirm_expires_at?: string | null }): Promise<WaitlistRow | null>;
  getWaitlist(tenantId: string, id: string): Promise<WaitlistRow | null>;
  listWaitlist(tenantId: string, sessionId: string): Promise<WaitlistRow[]>;
  updateWaitlist(tenantId: string, id: string, from: WaitlistStatus[], patch: Partial<Pick<WaitlistRow, "status">>): Promise<WaitlistRow | null>;
  /** builder_offer_waitlist：過期保留 lapsed、依序給出新保留，回傳新給出的 */
  offerWaitlist(tenantId: string, sessionId: string, hours: number): Promise<WaitlistRow[]>;
  insertPiiLog(row: Omit<PiiAccessRow, "id" | "at">): Promise<void>;
  // hook 失敗紀錄（M2）
  /** 同一 (order, hook, event) 已有未解決紀錄 → attempts+1；已解決 → 重新開啟 */
  recordHookFailure(row: { tenant_id: string; order_id: string; hook: string; event: "paid" | "cancelled"; error: string }): Promise<void>;
  listOpenHookFailures(opts: { orderId?: string; tenantId?: string; limit: number; maxAttempts: number }): Promise<HookFailureRow[]>;
  resolveHookFailure(id: string, how: "retried" | "obsolete"): Promise<void>;
  /** attempts+1，回傳新次數 */
  bumpHookFailure(id: string, error: string): Promise<number>;
  /** alerted_at 由 null 改成 now 的那一次回 true */
  markHookFailureAlerted(id: string): Promise<boolean>;
  listPiiLog(tenantId: string, limit: number): Promise<PiiAccessRow[]>;

  // booking
  insertProvider(row: Pick<ProviderRow, "tenant_id" | "name" | "email" | "active" | "sort">): Promise<ProviderRow>;
  listProviders(tenantId: string): Promise<ProviderRow[]>;
  getProvider(tenantId: string, id: string): Promise<ProviderRow | null>;
  insertService(row: Omit<ServiceRow, "id" | "created_at" | "updated_at">): Promise<ServiceRow>;
  updateService(tenantId: string, id: string, patch: Partial<Omit<ServiceRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<ServiceRow | null>;
  getServiceById(tenantId: string, id: string): Promise<ServiceRow | null>;
  getServiceBySlug(tenantId: string, slug: string): Promise<ServiceRow | null>;
  listServices(tenantId: string, opts: { status?: ServiceRow["status"] }): Promise<ServiceRow[]>;
  /** 整份取代某提供者的每週時段 */
  replaceWeeklyHours(tenantId: string, providerId: string, rows: Pick<HoursRow, "weekday" | "start_min" | "end_min">[]): Promise<HoursRow[]>;
  listWeeklyHours(tenantId: string, providerId: string): Promise<HoursRow[]>;
  insertOverride(row: Omit<OverrideRow, "id" | "created_at">): Promise<OverrideRow>;
  listOverrides(tenantId: string, providerId: string, fromDate: string, toDate: string): Promise<OverrideRow[]>;
  /** 不收費（或現場付）的預約：原子防重複（builder_reserve_booking，order=null → confirmed） */
  reserveBookingFree(tenantId: string, res: BookingReservation): Promise<string>;
  getBooking(tenantId: string, id: string): Promise<BookingRow | null>;
  listBookings(tenantId: string, opts: { providerId?: string; fromIso?: string; toIso?: string; status?: BookingStatus[]; orderId?: string; memberId?: string; limit: number; offset: number }): Promise<{ rows: BookingRow[]; total: number }>;
  /** 有效預約（held＋confirmed）在 [fromIso, toIso) 附近的占用區間 [starts_at, block_until) */
  busyIntervals(tenantId: string, providerId: string, fromIso: string, toIso: string): Promise<Pick<BookingRow, "starts_at" | "block_until">[]>;
  updateBooking(tenantId: string, id: string, from: BookingStatus[], patch: Partial<Pick<BookingRow, "status" | "reminder_sent_at" | "refund_required" | "cancelled_at" | "cancel_reason" | "cancelled_by">>, opts?: { requireNull?: "reminder_sent_at"[] }): Promise<BookingRow | null>;
  /** builder_reschedule_booking：鎖提供者、排除自己判斷重疊；時段被占丟 ServiceError(conflict)；狀態不是 held／confirmed 回 false */
  rescheduleBooking(tenantId: string, id: string, startIso: string, endIso: string, blockIso: string): Promise<boolean>;
  listExpiredHeldOrderIdsForProvider(tenantId: string, providerId: string, nowIso: string): Promise<string[]>;
  /** 所有租戶：開始時間在 [fromIso, toIso) 的已確認預約（提醒 cron） */
  listBookingsStartingBetween(fromIso: string, toIso: string, limit: number): Promise<BookingRow[]>;

  // courses
  insertCourse(row: Omit<CourseRow, "id" | "created_at" | "updated_at">): Promise<CourseRow>;
  updateCourse(tenantId: string, id: string, patch: Partial<Omit<CourseRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<CourseRow | null>;
  getCourseById(tenantId: string, id: string): Promise<CourseRow | null>;
  getCourseBySlug(tenantId: string, slug: string): Promise<CourseRow | null>;
  listCourses(tenantId: string, opts: { status?: CourseRow["status"] }): Promise<CourseRow[]>;
  insertLesson(row: Omit<LessonRow, "id" | "created_at" | "updated_at">): Promise<LessonRow>;
  updateLesson(tenantId: string, id: string, patch: Partial<Omit<LessonRow, "id" | "tenant_id" | "course_id" | "created_at" | "updated_at">>): Promise<LessonRow | null>;
  getLesson(tenantId: string, id: string): Promise<LessonRow | null>;
  getLessonBySlug(tenantId: string, courseId: string, slug: string): Promise<LessonRow | null>;
  listLessons(tenantId: string, courseIds: string[]): Promise<LessonRow[]>;
  /** builder_grant_enrollment：冪等開通（已開通回 granted=false；已撤銷會重新開通） */
  grantEnrollment(tenantId: string, input: { courseId: string; memberId: string; source: EnrollmentRow["source"]; orderId: string | null; by: string }): Promise<{ id: string; granted: boolean }>;
  /** 條件式撤銷（active → revoked）；可限定 orderId（訂單取消只撤銷「由這張訂單開通」的） */
  revokeEnrollment(tenantId: string, where: { id?: string; orderId?: string; courseId?: string; memberId?: string }, patch: { by: string; reason: string }): Promise<EnrollmentRow[]>;
  getEnrollment(tenantId: string, courseId: string, memberId: string): Promise<EnrollmentRow | null>;
  listEnrollments(tenantId: string, opts: { courseId?: string; memberId?: string; status?: EnrollmentRow["status"]; limit: number; offset: number }): Promise<{ rows: EnrollmentRow[]; total: number }>;
  /** 完成單元（冪等：同一會員同一單元只一列） */
  markLessonDone(row: { tenant_id: string; course_id: string; lesson_id: string; member_id: string }): Promise<void>;
  listProgress(tenantId: string, memberId: string, courseId: string): Promise<{ lesson_id: string; completed_at: string }[]>;

  // 課程類訂單（活動票／預約／課程）
  /** builder_place_class_order：訂單＋品項＋優惠券＋名額預留在同一交易；任一失敗整筆不成立 */
  placeClassOrder(tenantId: string, order: ClassOrderInput, items: ClassOrderItem[], day: string, res: ClassReservation): Promise<{ id: string; order_no: string; reservation_id: string | null }>;
}
