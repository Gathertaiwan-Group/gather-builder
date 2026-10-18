import { z } from "zod";
import { PROVIDER_IDS } from "../pay/types";
import type { BookingRow, BookingStatus, MemberRow, OrderRow, ProviderRow, ServiceRow, Store, TenantRow } from "../store/types";
import type { BookingSettings } from "@/modules/booking/manifest";
import { optText, postSlug, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, publishedShopSettings, twd, type CheckoutDeps } from "./shop";
import { registerOrderHooks, type HookDeps } from "./order-hooks";
import { cancelOrderWithHooks, expireIfDue } from "./orders";
import { emailKey } from "./members";
import { normalizeEmail } from "../email-normalize";
import { classContactInput, maskContact } from "./class-common";
import { fmtTaipei, fmtTaipeiTime, placeClassOrder, shopActive, signFor, verifySigned } from "./class-orders";
import { addDays, canSelfCancel, computeAvailability, fmtHm, isBookable, parseHm, taipeiDateOf, type DaySlots } from "../booking/availability";
import { buildIcs } from "../booking/ics";
import type { MailAttachment } from "../mail";

/* ================================================================== 共用 */

export const DEFAULTS = { minLeadMinutes: 120, maxAdvanceDays: 60, slotStepMinutes: 30, cancelDeadlineHours: 24 };

export async function bookingActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("booking");
}
async function requireBooking(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await bookingActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「booking」，請先 enable_module booking");
}
export type EffectiveBookingSettings = BookingSettings & typeof DEFAULTS;
export async function bookingSettingsFor(store: Store, tenant: TenantRow): Promise<EffectiveBookingSettings> {
  const s = (await publishedModuleSettings(store, tenant, "booking")) as BookingSettings;
  return {
    ...s,
    minLeadMinutes: s.minLeadMinutes ?? DEFAULTS.minLeadMinutes,
    maxAdvanceDays: s.maxAdvanceDays ?? DEFAULTS.maxAdvanceDays,
    slotStepMinutes: s.slotStepMinutes ?? DEFAULTS.slotStepMinutes,
    cancelDeadlineHours: s.cancelDeadlineHours ?? DEFAULTS.cancelDeadlineHours,
  };
}
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上可預約的時段，需要 scope「publish」。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

/** 第一版：沒有提供者時自動建立「店主」（資料結構支援多位） */
export async function ensureProvider(store: Store, tenant: TenantRow, providerId?: string | null): Promise<ProviderRow> {
  if (providerId) {
    const p = await store.getProvider(tenant.id, providerId);
    if (!p) throw new ServiceError("not_found", "找不到這位服務提供者");
    return p;
  }
  const list = await store.listProviders(tenant.id);
  const active = list.find((p) => p.active);
  if (active) return active;
  if (list.length) throw new ServiceError("invalid", "沒有啟用中的服務提供者");
  return store.insertProvider({ tenant_id: tenant.id, name: "店主", email: null, active: true, sort: 0 });
}

const amountDue = (s: ServiceRow) => (s.payment_mode === "full" ? s.price : s.payment_mode === "deposit" ? (s.deposit_amount ?? 0) : 0);

/* ================================================================== 服務／時段（MCP＋後台） */

export const serviceInput = z
  .object({
    slug: postSlug,
    name: text(120),
    descriptionMd: z.string().max(20_000).default(""),
    durationMin: z.number().int().min(5).max(720),
    bufferMin: z.number().int().min(0).max(240).default(0),
    price: z.number().int().min(0).max(1_000_000).default(0),
    /** none：不線上收費（現場付）；deposit：線上收訂金 depositAmount；full：線上收全額 */
    paymentMode: z.enum(["none", "deposit", "full"]).default("none"),
    depositAmount: z.number().int().min(1).max(1_000_000).optional(),
    status: z.enum(["draft", "published"]).default("draft"),
    sort: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict();

function checkPayment(d: { price: number; paymentMode: "none" | "deposit" | "full"; depositAmount?: number }) {
  if (d.paymentMode === "deposit" && (!d.depositAmount || d.depositAmount > d.price)) throw new ServiceError("invalid", "收訂金時 depositAmount 必填，且不能超過價格");
  if (d.paymentMode === "full" && d.price <= 0) throw new ServiceError("invalid", "全額線上付款的服務價格要大於 0");
}

function serviceSummary(s: ServiceRow) {
  return { id: s.id, slug: s.slug, name: s.name, durationMin: s.duration_min, bufferMin: s.buffer_min, price: s.price, paymentMode: s.payment_mode, depositAmount: s.deposit_amount, amountDueOnline: amountDue(s), status: s.status };
}

export async function createService(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof serviceInput>) {
  requireScope(ctx, "classes:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireBooking(ctx, tenant);
  const d = parse(serviceInput, rest);
  checkPayment(d);
  if (d.paymentMode !== "none" && !(await shopActive(ctx.store, tenant.id))) throw new ServiceError("invalid", "線上收訂金／全額需要先啟用 shop 模組（線下匯款或 PChomePay）：enable_module shop");
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架服務", confirm);
  if (await ctx.store.getServiceBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `服務 slug「${d.slug}」已存在`);
  await ensureProvider(ctx.store, tenant);
  const row = await ctx.store.insertService({
    tenant_id: tenant.id,
    slug: d.slug,
    name: d.name,
    description_md: d.descriptionMd,
    duration_min: d.durationMin,
    buffer_min: d.bufferMin,
    price: d.price,
    payment_mode: d.paymentMode,
    deposit_amount: d.paymentMode === "deposit" ? (d.depositAmount ?? null) : null,
    status: d.status,
    sort: d.sort,
  });
  await audit(ctx, tenant.id, "booking.service.create", { serviceId: row.id, slug: row.slug });
  return { ...serviceSummary(row), note: "服務已建立。用 set_weekly_hours 設定每週可預約時段（需 confirm），上架後客人即可在 /book 預約。" };
}

export async function updateService(ctx: ServiceContext, input: { site?: string | null; serviceId?: string; slug?: string; confirm?: boolean; patch: Partial<z.input<typeof serviceInput>> }) {
  requireScope(ctx, "classes:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const s = input.serviceId ? await ctx.store.getServiceById(tenant.id, input.serviceId) : input.slug ? await ctx.store.getServiceBySlug(tenant.id, input.slug) : null;
  if (!s) throw new ServiceError("not_found", "找不到服務（請給 serviceId 或 slug）");
  const given = input.patch ?? {};
  const p = parse(serviceInput.partial().strict(), given);
  const merged = { price: p.price ?? s.price, paymentMode: p.paymentMode ?? s.payment_mode, depositAmount: p.depositAmount ?? s.deposit_amount ?? undefined };
  checkPayment(merged);
  if ((given.status ?? s.status) === "published" || s.status === "published") requireLiveConfirm(ctx, "修改／上架／下架已上架的服務", input.confirm);
  if (merged.paymentMode !== "none" && !(await shopActive(ctx.store, tenant.id))) throw new ServiceError("invalid", "線上收訂金／全額需要先啟用 shop 模組");
  if (p.slug && p.slug !== s.slug && (await ctx.store.getServiceBySlug(tenant.id, p.slug))) throw new ServiceError("conflict", `服務 slug「${p.slug}」已存在`);
  const patch: Parameters<Store["updateService"]>[2] = {};
  if (given.slug !== undefined) patch.slug = p.slug;
  if (given.name !== undefined) patch.name = p.name;
  if (given.descriptionMd !== undefined) patch.description_md = p.descriptionMd;
  if (given.durationMin !== undefined) patch.duration_min = p.durationMin;
  if (given.bufferMin !== undefined) patch.buffer_min = p.bufferMin;
  if (given.price !== undefined) patch.price = p.price;
  if (given.paymentMode !== undefined) patch.payment_mode = p.paymentMode;
  if (given.depositAmount !== undefined || given.paymentMode !== undefined) patch.deposit_amount = merged.paymentMode === "deposit" ? (merged.depositAmount ?? null) : null;
  if (given.status !== undefined) patch.status = p.status;
  if (given.sort !== undefined) patch.sort = p.sort;
  const row = (await ctx.store.updateService(tenant.id, s.id, patch))!;
  await audit(ctx, tenant.id, "booking.service.update", { serviceId: s.id, keys: Object.keys(given) });
  return serviceSummary(row);
}

export async function listServices(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const [services, providers] = await Promise.all([ctx.store.listServices(tenant.id, {}), ctx.store.listProviders(tenant.id)]);
  const hours = providers.length ? await ctx.store.listWeeklyHours(tenant.id, providers[0]!.id) : [];
  return {
    services: services.map(serviceSummary),
    providers: providers.map((p) => ({ id: p.id, name: p.name, active: p.active })),
    weeklyHours: hours.map((h) => ({ weekday: h.weekday, start: fmtHm(h.start_min), end: fmtHm(h.end_min) })),
    settings: await bookingSettingsFor(ctx.store, tenant),
  };
}

const hm = z.string().trim().regex(/^\d{1,2}:\d{2}$/, { message: "時間格式 HH:MM，例如 09:30" });
export const weeklyHoursInput = z
  .array(z.object({ weekday: z.number().int().min(0).max(6), start: hm, end: hm }).strict())
  .max(70)
  .superRefine((rows, c) => {
    rows.forEach((r, i) => {
      const s = parseHm(r.start);
      const e = parseHm(r.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) c.addIssue({ code: "custom", path: [i], message: `第 ${i + 1} 段：結束要晚於開始（00:00–24:00）` });
    });
  });

/** 整份取代每週時段（0＝週日…6＝週六，台北時間）。會立即改變線上可預約時段 → publish＋confirm */
export async function setWeeklyHours(ctx: ServiceContext, input: { site?: string | null; providerId?: string; hours: z.input<typeof weeklyHoursInput>; confirm?: boolean }) {
  requireScope(ctx, "classes:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const rows = parse(weeklyHoursInput, input.hours);
  const p = await ensureProvider(ctx.store, tenant, input.providerId);
  requireLiveConfirm(ctx, `把「${p.name}」的每週可預約時段改成 ${rows.length} 段`, input.confirm);
  const saved = await ctx.store.replaceWeeklyHours(tenant.id, p.id, rows.map((r) => ({ weekday: r.weekday, start_min: parseHm(r.start), end_min: parseHm(r.end) })));
  await audit(ctx, tenant.id, "booking.hours.set", { providerId: p.id, rows: saved.length });
  const W = "日一二三四五六";
  return { providerId: p.id, hours: saved.map((h) => `週${W[h.weekday]} ${fmtHm(h.start_min)}–${fmtHm(h.end_min)}`) };
}

export const overrideInput = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "日期格式 YYYY-MM-DD（台北）" }),
    kind: z.enum(["closed", "open"]),
    start: hm.optional(),
    end: hm.optional(),
    note: optText(200),
  })
  .strict();

/** 例外日：closed＝整天休假；open＝加開時段（start／end）。立即生效 → publish＋confirm */
export async function addDateOverride(ctx: ServiceContext, input: { site?: string | null; providerId?: string; confirm?: boolean } & z.input<typeof overrideInput>) {
  requireScope(ctx, "classes:write");
  const { site, providerId, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireBooking(ctx, tenant);
  const d = parse(overrideInput, rest);
  let s: number | null = null;
  let e: number | null = null;
  if (d.kind === "open") {
    s = parseHm(d.start ?? "");
    e = parseHm(d.end ?? "");
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new ServiceError("invalid", "加開時段要給 start／end（HH:MM），且結束晚於開始");
  }
  const p = await ensureProvider(ctx.store, tenant, providerId);
  requireLiveConfirm(ctx, d.kind === "closed" ? `把 ${d.date} 設為休假（已預約的不會自動取消）` : `在 ${d.date} 加開 ${d.start}–${d.end}`, confirm);
  const row = await ctx.store.insertOverride({ tenant_id: tenant.id, provider_id: p.id, date: d.date, kind: d.kind, start_min: s, end_min: e, note: d.note ?? null });
  await audit(ctx, tenant.id, "booking.override.add", { providerId: p.id, date: d.date, kind: d.kind });
  const existing = d.kind === "closed" ? (await ctx.store.listBookings(tenant.id, { providerId: p.id, fromIso: new Date(Date.parse(`${d.date}T00:00:00+08:00`)).toISOString(), toIso: new Date(Date.parse(`${d.date}T00:00:00+08:00`) + 86400_000).toISOString(), status: ["held", "confirmed"], limit: 50, offset: 0 })).total : 0;
  return { id: row.id, date: row.date, kind: row.kind, start: s === null ? null : fmtHm(s), end: e === null ? null : fmtHm(e), note: existing ? `這天已有 ${existing} 筆預約，休假不會自動取消它們，請用 cancel_booking 處理。` : undefined };
}

/* ================================================================== 可預約時段 */

export async function availabilityFor(store: Store, tenant: TenantRow, service: ServiceRow, opts: { providerId?: string | null; fromDate?: string; days?: number; now?: Date }): Promise<{ provider: ProviderRow; days: DaySlots[] }> {
  const now = opts.now ?? new Date();
  const settings = await bookingSettingsFor(store, tenant);
  const provider = await ensureProvider(store, tenant, opts.providerId);
  const fromDate = opts.fromDate ?? taipeiDateOf(now);
  const days = Math.max(1, Math.min(31, opts.days ?? 7));
  const toDate = addDays(fromDate, days);
  const [weekly, overrides, busy] = await Promise.all([
    store.listWeeklyHours(tenant.id, provider.id),
    store.listOverrides(tenant.id, provider.id, fromDate, toDate),
    store.busyIntervals(tenant.id, provider.id, new Date(Date.parse(`${fromDate}T00:00:00+08:00`) - 86400_000).toISOString(), new Date(Date.parse(`${toDate}T00:00:00+08:00`) + 86400_000).toISOString()),
  ]);
  return {
    provider,
    days: computeAvailability({
      now,
      fromDate,
      days,
      weekly: weekly.map((h) => ({ weekday: h.weekday, startMin: h.start_min, endMin: h.end_min })),
      overrides: overrides.map((o) => ({ date: o.date, kind: o.kind, startMin: o.start_min, endMin: o.end_min })),
      busy: busy.map((b) => ({ start: b.starts_at, end: b.block_until })),
      durationMin: service.duration_min,
      bufferMin: service.buffer_min,
      stepMin: settings.slotStepMinutes,
      minLeadMin: settings.minLeadMinutes,
      maxAdvanceDays: settings.maxAdvanceDays,
    }),
  };
}

export async function getBookingAvailability(ctx: ServiceContext, input: { site?: string | null; serviceId?: string; serviceSlug?: string; fromDate?: string; days?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const s = input.serviceId ? await ctx.store.getServiceById(tenant.id, input.serviceId) : input.serviceSlug ? await ctx.store.getServiceBySlug(tenant.id, input.serviceSlug) : null;
  if (!s) throw new ServiceError("not_found", "找不到服務");
  const r = await availabilityFor(ctx.store, tenant, s, { fromDate: input.fromDate, days: input.days });
  return { service: serviceSummary(s), provider: { id: r.provider.id, name: r.provider.name }, days: r.days.map((d) => ({ date: d.date, slots: d.slots.map((x) => ({ start: x.start, label: fmtTaipeiTime(x.start) })) })) };
}

/* ================================================================== 建立預約（公開） */

export const bookInput = z
  .object({
    serviceId: z.string().trim().min(1).max(64),
    providerId: z.string().trim().max(64).optional(),
    startsAt: z.iso.datetime({ offset: true }),
    contact: classContactInput,
    paymentMethod: z.enum(["offline", ...PROVIDER_IDS]).optional(),
    couponCode: z.string().trim().max(32).optional(),
    referralCode: z.string().trim().max(16).optional(),
    note: optText(500),
  })
  .strict();

/** 預約前：釋放這位提供者已逾期未付的保留（線上付款單先權威回查） */
export async function releaseExpiredBookingHolds(deps: CheckoutDeps, tenant: TenantRow, providerId: string) {
  const due = await deps.store.listExpiredHeldOrderIdsForProvider(tenant.id, providerId, new Date().toISOString());
  for (const id of due) {
    const o = await deps.store.getOrderById(tenant.id, id);
    if (o) await expireIfDue(deps.store, o, Date.now(), deps);
  }
}

/** 每個 Email 每天最多幾筆免費預約（設定 freeBookingsPerEmailPerDay 可改） */
export const DEFAULT_FREE_BOOKINGS_PER_EMAIL_PER_DAY = 2;

export type BookResult = { kind: "confirmed"; booking: BookingRow; manageUrl: string } | { kind: "order"; order: OrderRow; accessKey: string; orderUrl: string; bookingId: string | null };

/**
 * 預約（公開）：時段必須是純函式算出的可約時段（營業時間、例外日、緩衝、最早／最遠）；
 * 同一提供者同時段只能一筆——由 DB 交易（鎖提供者列＋tstzrange 重疊）保證，併發只成功一筆。
 * 不線上收費 → 直接確認（寄 .ics）；收訂金／全額 → 建訂單（同交易保留），付款後確認。
 */
export async function bookSlot(deps: CheckoutDeps, input: { tenant: TenantRow; member: MemberRow | null; data: unknown; allowSandbox?: boolean; now?: Date }): Promise<BookResult> {
  const { tenant, member } = input;
  if (!(await bookingActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放預約");
  const settings = await bookingSettingsFor(deps.store, tenant);
  if (settings.allowGuest === false && !member) throw new ServiceError("unauthorized", "請先登入會員再預約");
  const d = parse(bookInput, input.data);
  const s = await deps.store.getServiceById(tenant.id, d.serviceId);
  if (!s || s.status !== "published") throw new ServiceError("not_found", "找不到這個服務");
  const provider = await ensureProvider(deps.store, tenant, d.providerId);
  await releaseExpiredBookingHolds(deps, tenant, provider.id);
  const r = await availabilityFor(deps.store, tenant, s, { providerId: provider.id, fromDate: taipeiDateOf(new Date(d.startsAt)), days: 1, now: input.now });
  const slot = r.days[0]?.slots.find((x) => new Date(x.start).getTime() === new Date(d.startsAt).getTime());
  if (!slot) throw new ServiceError("conflict", "這個時段無法預約（可能已被預約、不在營業時間或太近／太遠），請重新選擇");
  const block = new Date(new Date(slot.end).getTime() + s.buffer_min * 60_000).toISOString();
  const res = { provider_id: provider.id, service_id: s.id, starts_at: slot.start, ends_at: slot.end, block_until: block, price: s.price, amount_due: amountDue(s), contact: d.contact, member_id: member?.id ?? null, note: d.note ?? null };
  const due = amountDue(s);
  if (due <= 0) {
    // M5：每個 Email（正規化）每天的免費預約上限（原子計數；跨 IP 有效）
    const secret = process.env.PREVIEW_SECRET ?? "dev-secret";
    const hit = await deps.store.rateHit(`booking-free-email:${tenant.id}`, emailKey(normalizeEmail(d.contact.email), secret), 86400, settings.freeBookingsPerEmailPerDay ?? DEFAULT_FREE_BOOKINGS_PER_EMAIL_PER_DAY);
    if (!hit.allowed) throw new ServiceError("rate_limited", "這個 Email 今天的預約次數已達上限，請明天再試或直接聯絡店家");
    const id = await deps.store.reserveBookingFree(tenant.id, res);
    const b = (await deps.store.getBooking(tenant.id, id))!;
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: member ? `member:${member.id}` : "guest", action: "booking.create", payload: { bookingId: id, paid: false } });
    await sendBookingConfirmed(deps, tenant, b, s);
    return { kind: "confirmed", booking: b, manageUrl: manageUrl(deps.baseUrl, tenant, b) };
  }
  const o = await placeClassOrder(deps, {
    tenant,
    member,
    contact: d.contact,
    item: { item_kind: "booking", ref_id: s.id, name: `${s.name}｜${fmtTaipei(slot.start)}`, variant_label: s.payment_mode === "deposit" ? `訂金（總價 ${twd(s.price)}）` : null, sku: null, unit_price: due, qty: 1, line_total: due },
    reservation: { kind: "booking", data: res },
    paymentMethod: d.paymentMethod ?? "offline",
    couponCode: d.couponCode,
    referralCode: d.referralCode,
    note: d.note,
    allowSandbox: input.allowSandbox,
    holdUntilMax: new Date(slot.start),
  });
  return { kind: "order", order: o.order, accessKey: o.accessKey, orderUrl: o.orderUrl, bookingId: o.reservationId };
}

/* ================================================================== 自助管理（簽章連結）、.ics、信件 */

export const manageToken = (b: Pick<BookingRow, "id">) => signFor("booking", b.id);
export function manageUrl(baseUrl: string, tenant: TenantRow, b: Pick<BookingRow, "id">) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/book/manage?b=${encodeURIComponent(b.id)}&t=${encodeURIComponent(manageToken(b))}`;
}

export async function managedBooking(store: Store, tenant: TenantRow, id: unknown, token: unknown) {
  if (typeof id !== "string" || !verifySigned("booking", id, token)) return null;
  const b = await store.getBooking(tenant.id, id);
  if (!b) return null;
  const s = await store.getServiceById(tenant.id, b.service_id);
  return s ? { booking: b, service: s } : null;
}

export async function bookingIcs(store: Store, tenant: TenantRow, b: BookingRow, s: ServiceRow, baseUrl: string, cancelled = false) {
  const settings = await bookingSettingsFor(store, tenant);
  return buildIcs({
    uid: `booking-${b.id}@gather-builder`,
    start: b.starts_at,
    end: b.ends_at,
    summary: `${s.name}｜${tenant.name}`,
    description: `預約：${s.name}\n管理預約：${manageUrl(baseUrl, tenant, b)}`,
    location: settings.location,
    cancelled,
    sequence: b.rescheduled_at ? Math.floor(new Date(b.rescheduled_at).getTime() / 1000) % 100000 : cancelled ? 1 : 0,
  });
}

async function sendBookingConfirmed(deps: { store: Store; sendMail?: CheckoutDeps["sendMail"]; baseUrl: string }, tenant: TenantRow, b: BookingRow, s: ServiceRow, subjectPrefix = "預約成功", paidAmount?: number) {
  const settings = await bookingSettingsFor(deps.store, tenant);
  const ics: MailAttachment = { filename: "booking.ics", content: await bookingIcs(deps.store, tenant, b, s, deps.baseUrl), contentType: "text/calendar; charset=utf-8; method=PUBLISH" };
  const deadline = settings.cancelDeadlineHours;
  await mailSafe(
    deps,
    b.contact.email,
    `【${tenant.name}】${subjectPrefix}：${s.name} ${fmtTaipei(b.starts_at)}`,
    `${b.contact.name} 你好，\n\n${subjectPrefix}：\n${s.name}\n時間：${fmtTaipei(b.starts_at)}–${fmtTaipeiTime(b.ends_at)}${settings.location ? `\n地點：${settings.location}` : ""}${b.amount_due ? `\n${paidAmount !== undefined ? `已付：${twd(paidAmount)}` : `應付：${twd(b.amount_due)}`}${b.amount_due < b.price ? `（訂金，總價 ${twd(b.price)}）` : ""}` : b.price ? `\n費用：${twd(b.price)}（現場付款）` : ""}\n\n附件是行事曆檔（.ics），可加入你的行事曆。\n${deadline ? `開始前 ${deadline} 小時以前` : "開始前"}可以自助取消或改期：\n${manageUrl(deps.baseUrl, tenant, b)}`,
    [ics],
  );
  const owner = settings.ownerEmail ?? (await publishedShopSettings(deps.store, tenant)).ownerEmail;
  if (owner) await mailSafe(deps, owner, `【${tenant.name}】新預約：${s.name} ${fmtTaipei(b.starts_at)}`, `預約者：${maskContact(b.contact).name}（完整資料請到後台查看）`);
}

/** 客人自助取消（簽章連結＋最晚取消時間）。已付款 → 取消並標待退款（不自動退款）；未付款保留 → 取消訂單 */
export async function selfCancelBooking(deps: CheckoutDeps, input: { tenant: TenantRow; bookingId: unknown; token: unknown; now?: Date }) {
  const m = await managedBooking(deps.store, input.tenant, input.bookingId, input.token);
  if (!m) throw new ServiceError("not_found", "預約連結無效");
  const settings = await bookingSettingsFor(deps.store, input.tenant);
  if (!["held", "confirmed"].includes(m.booking.status)) throw new ServiceError("conflict", "這筆預約已經取消了");
  if (!canSelfCancel(m.booking.starts_at, input.now ?? new Date(), settings.cancelDeadlineHours)) throw new ServiceError("invalid", `開始前 ${settings.cancelDeadlineHours} 小時內無法線上取消，請直接聯絡店家`);
  return cancelBookingCore(deps, input.tenant, m.booking, m.service, "customer", "客人自助取消");
}

async function cancelBookingCore(deps: CheckoutDeps, tenant: TenantRow, b: BookingRow, s: ServiceRow, by: string, reason: string) {
  const o = b.order_id ? await deps.store.getOrderById(tenant.id, b.order_id) : null;
  let refund = false;
  if (o && o.status === "pending_payment") {
    // L2：走會跑取消 hooks 的服務函式（優惠券／名額同交易回補，hooks 處理其他模組的副作用）
    await cancelOrderWithHooks(deps, tenant, o.id, ["pending_payment"], "booking_cancelled");
  } else {
    refund = !!o && (o.status === "paid" || o.status === "fulfilled") && !o.payment_sandbox;
    const moved = await deps.store.updateBooking(tenant.id, b.id, ["held", "confirmed"], { status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: reason.slice(0, 200), cancelled_by: by, refund_required: refund });
    if (!moved) throw new ServiceError("conflict", "預約狀態已被其他操作改變，請重新整理");
  }
  const after = (await deps.store.getBooking(tenant.id, b.id))!;
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: by, action: "booking.cancel", payload: { bookingId: b.id, refundRequired: refund } });
  const ics: MailAttachment = { filename: "booking-cancel.ics", content: await bookingIcs(deps.store, tenant, after, s, deps.baseUrl, true), contentType: "text/calendar; charset=utf-8; method=CANCEL" };
  await mailSafe(deps, b.contact.email, `【${tenant.name}】預約已取消：${s.name} ${fmtTaipei(b.starts_at)}`, `${b.contact.name} 你好，\n\n你的預約（${s.name} ${fmtTaipei(b.starts_at)}）已取消。原因：${reason}${refund ? `\n你已付款（訂單 ${o!.order_no}），店家會與你聯繫退款。` : ""}`, [ics]);
  const settings = await bookingSettingsFor(deps.store, tenant);
  const owner = settings.ownerEmail ?? (await publishedShopSettings(deps.store, tenant)).ownerEmail;
  if (owner) await mailSafe(deps, owner, `【${tenant.name}】預約取消：${s.name} ${fmtTaipei(b.starts_at)}`, `由 ${by === "customer" ? "客人自助" : by} 取消。${refund ? "已付款，需要人工退款。" : ""}`);
  return { bookingId: b.id, status: after.status, refundRequired: refund, note: refund ? "已付款：不會自動退款，請人工退款（線上付款到 PChomePay 商家後台）。" : "預約已取消。" };
}

/** 客人自助改期（同一服務、同一提供者；新時段要可約，且原預約還在最晚取消時間之前） */
export async function selfRescheduleBooking(deps: CheckoutDeps, input: { tenant: TenantRow; bookingId: unknown; token: unknown; startsAt: unknown; now?: Date }) {
  const m = await managedBooking(deps.store, input.tenant, input.bookingId, input.token);
  if (!m) throw new ServiceError("not_found", "預約連結無效");
  const { booking: b, service: s } = m;
  const settings = await bookingSettingsFor(deps.store, input.tenant);
  if (!["held", "confirmed"].includes(b.status)) throw new ServiceError("conflict", "這筆預約已經取消了");
  if (!canSelfCancel(b.starts_at, input.now ?? new Date(), settings.cancelDeadlineHours)) throw new ServiceError("invalid", `開始前 ${settings.cancelDeadlineHours} 小時內無法線上改期，請直接聯絡店家`);
  const start = parse(z.iso.datetime({ offset: true }), input.startsAt);
  // 計算可約時段時排除自己目前占用的區間
  const date = taipeiDateOf(new Date(start));
  const weekly = await deps.store.listWeeklyHours(input.tenant.id, b.provider_id);
  const overrides = await deps.store.listOverrides(input.tenant.id, b.provider_id, date, date);
  const busy = (await deps.store.busyIntervals(input.tenant.id, b.provider_id, new Date(Date.parse(`${date}T00:00:00+08:00`) - 86400_000).toISOString(), new Date(Date.parse(`${date}T00:00:00+08:00`) + 2 * 86400_000).toISOString())).filter((x) => !(x.starts_at === b.starts_at && x.block_until === b.block_until));
  const slot = isBookable(
    {
      now: input.now ?? new Date(),
      weekly: weekly.map((h) => ({ weekday: h.weekday, startMin: h.start_min, endMin: h.end_min })),
      overrides: overrides.map((o) => ({ date: o.date, kind: o.kind, startMin: o.start_min, endMin: o.end_min })),
      busy: busy.map((x) => ({ start: x.starts_at, end: x.block_until })),
      durationMin: s.duration_min,
      bufferMin: s.buffer_min,
      stepMin: settings.slotStepMinutes,
      minLeadMin: settings.minLeadMinutes,
      maxAdvanceDays: settings.maxAdvanceDays,
    },
    start,
  );
  if (!slot) throw new ServiceError("conflict", "這個時段無法預約，請重新選擇");
  const ok = await deps.store.rescheduleBooking(input.tenant.id, b.id, slot.start, slot.end, new Date(new Date(slot.end).getTime() + s.buffer_min * 60_000).toISOString());
  if (!ok) throw new ServiceError("conflict", "這筆預約已經取消了");
  const after = (await deps.store.getBooking(input.tenant.id, b.id))!;
  const order = after.order_id ? await deps.store.getOrderById(input.tenant.id, after.order_id) : null;
  // L8：未付款的保留改期 → 訂單付款期限不得晚於新時段開始時間
  if (order && order.status === "pending_payment" && order.expires_at && new Date(order.expires_at).getTime() > new Date(after.starts_at).getTime()) {
    await deps.store.setOrderFields(input.tenant.id, order.id, { expires_at: after.starts_at });
  }
  await deps.store.insertAudit({ tenant_id: input.tenant.id, actor: "customer", action: "booking.reschedule", payload: { bookingId: b.id, from: b.starts_at, to: after.starts_at } });
  await sendBookingConfirmed(deps, input.tenant, after, s, "預約已改期", order && (order.status === "paid" || order.status === "fulfilled") ? order.total : undefined);
  return { bookingId: b.id, startsAt: after.starts_at };
}

/* ================================================================== 後台＋MCP：列表、取消 */

function bookingSummary(b: BookingRow, s: ServiceRow | undefined, reveal = false) {
  return { id: b.id, service: s?.name ?? null, startsAt: b.starts_at, startsAtTaipei: fmtTaipei(b.starts_at), endsAt: b.ends_at, status: b.status, price: b.price, amountDue: b.amount_due, orderId: b.order_id, contact: reveal ? b.contact : maskContact(b.contact), refundRequired: b.refund_required, cancelledBy: b.cancelled_by };
}

export async function listBookings(ctx: ServiceContext, input: { site?: string | null; from?: string; to?: string; status?: BookingStatus[] }) {
  requireScope(ctx, "attendees:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const from = input.from ? new Date(parse(z.iso.datetime({ offset: true }), input.from)).toISOString() : new Date(Date.now() - 86400_000).toISOString();
  const to = input.to ? new Date(parse(z.iso.datetime({ offset: true }), input.to)).toISOString() : new Date(Date.now() + 60 * 86400_000).toISOString();
  // lazy 釋放逾期保留
  for (const p of await ctx.store.listProviders(tenant.id)) await releaseExpiredBookingHolds({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, p.id);
  const r = await ctx.store.listBookings(tenant.id, { fromIso: from, toIso: to, status: input.status, limit: 500, offset: 0 });
  const services = await ctx.store.listServices(tenant.id, {});
  return { total: r.total, bookings: r.rows.map((b) => bookingSummary(b, services.find((s) => s.id === b.service_id))), note: "聯絡資料已遮罩；完整資料請到後台查看（會留查看紀錄）。" };
}

export async function revealBooking(ctx: ServiceContext, input: { site?: string | null; bookingId: string }) {
  requireScope(ctx, "attendees:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const b = await ctx.store.getBooking(tenant.id, input.bookingId);
  if (!b) throw new ServiceError("not_found", "找不到預約");
  await ctx.store.insertPiiLog({ tenant_id: tenant.id, actor: ctx.actor.label, action: "reveal", subject_type: "booking", subject_id: b.id, detail: null });
  await audit(ctx, tenant.id, "pii.reveal", { bookingId: b.id });
  return bookingSummary(b, (await ctx.store.getServiceById(tenant.id, b.service_id)) ?? undefined, true);
}

export async function cancelBooking(ctx: ServiceContext, input: { site?: string | null; bookingId: string; reason?: string; confirm?: boolean }) {
  requireScope(ctx, "attendees:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireBooking(ctx, tenant);
  const b = await ctx.store.getBooking(tenant.id, input.bookingId);
  if (!b) throw new ServiceError("not_found", "找不到預約");
  if (!["held", "confirmed"].includes(b.status)) throw new ServiceError("conflict", "這筆預約已經取消了");
  const s = (await ctx.store.getServiceById(tenant.id, b.service_id))!;
  if (input.confirm !== true) throw new ServiceError("confirm_required", `取消 ${fmtTaipei(b.starts_at)} 的「${s.name}」預約會通知客人${b.order_id ? "（已付款者需人工退款）" : ""}。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const r = await cancelBookingCore({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, b, s, ctx.actor.label, input.reason?.trim() || "店家取消");
  await audit(ctx, tenant.id, "booking.cancel_by_owner", { bookingId: b.id });
  return r;
}

/* ================================================================== hooks／cron／會員中心 */

async function onBookingOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  const held = (await deps.store.listBookings(tenant.id, { orderId: order.id, status: ["held"], limit: 5, offset: 0 })).rows;
  for (const b of held) {
    const moved = await deps.store.updateBooking(tenant.id, b.id, ["held"], { status: "confirmed" });
    if (!moved) {
      // M2：已被確認＝冪等略過；其他狀態要丟出，由 hook 失敗紀錄補做／警示
      const cur = await deps.store.getBooking(tenant.id, b.id);
      if (cur?.status === "confirmed") continue;
      throw new Error(`預約 ${b.id} 已付款但狀態為 ${cur?.status ?? "不存在"}，無法確認（需人工處理）`);
    }
    const s = await deps.store.getServiceById(tenant.id, b.service_id);
    // L7：「已付」顯示訂單實付金額
    if (s) await sendBookingConfirmed(deps, tenant, moved, s, "預約成功", order.total);
  }
}
registerOrderHooks({ name: "booking", paid: onBookingOrderPaid });

/** 每日 cron：寄「現在到明天結束」之間開始的已確認預約提醒（reminder_sent_at 條件式，只寄一次） */
export async function runBookingCron(deps: { store: Store; sendMail?: CheckoutDeps["sendMail"]; baseUrl: string }, now = new Date()) {
  const until = new Date(Date.parse(`${addDays(taipeiDateOf(now), 2)}T00:00:00+08:00`));
  let reminded = 0;
  for (const b of await deps.store.listBookingsStartingBetween(now.toISOString(), until.toISOString(), 500)) {
    const tenant = await deps.store.getTenantById(b.tenant_id);
    if (!tenant || !(await bookingActive(deps.store, tenant.id))) continue;
    if ((await bookingSettingsFor(deps.store, tenant)).reminders === false) continue;
    const claimed = await deps.store.updateBooking(tenant.id, b.id, ["confirmed"], { reminder_sent_at: new Date().toISOString() }, { requireNull: ["reminder_sent_at"] });
    if (!claimed) continue;
    reminded++;
    const s = await deps.store.getServiceById(tenant.id, b.service_id);
    await mailSafe(deps, b.contact.email, `【${tenant.name}】預約提醒：${s?.name ?? "預約"} ${fmtTaipei(b.starts_at)}`, `${b.contact.name} 你好，\n\n提醒你明天（或今天稍晚）有預約：${s?.name ?? ""} ${fmtTaipei(b.starts_at)}。\n需要改期或取消：${manageUrl(deps.baseUrl, tenant, b)}`);
  }
  return { reminded };
}

export async function memberBookings(store: Store, tenant: TenantRow, member: MemberRow) {
  const r = await store.listBookings(tenant.id, { memberId: member.id, limit: 50, offset: 0 });
  const services = await store.listServices(tenant.id, {});
  return r.rows.slice().reverse().map((b) => ({ booking: b, service: services.find((s) => s.id === b.service_id) ?? null }));
}

export async function publicServices(store: Store, tenant: TenantRow) {
  return store.listServices(tenant.id, { status: "published" });
}
