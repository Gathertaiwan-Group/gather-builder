import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ClassOrderItem, ClassReservation, MemberRow, OrderRow, PaymentMethod, Store, TenantRow } from "../store/types";
import { PCHOMEPAY_MIN_AMOUNT } from "../pay/pchomepay";
import { ServiceError, activeModuleIds, moduleStates } from "./context";
import { emailSchema, sha256 } from "./members";
import { parse } from "./sites";
import { text } from "../validators";
import { DEFAULT_ONLINE_HOLD_MINUTES, MAX_ORDER_TOTAL, defaultOrderPrefix, orderPageUrl, paymentAvailability, publishedShopSettings, resolveInvoiceRequest, sendOrderPlacedMails, taipeiDay, type CheckoutDeps } from "./shop";
import { applyPromotions } from "./promotions";

/**
 * 課程類（活動票／預約／課程）共用的「建立訂單」：沿用 shop 的訂單＋付款整套機制——
 * 編號、付款方式可用性（含 sandbox 只限預覽簽章 H1）、線上最低金額、保留時間、優惠券原子扣用、推薦碼、發票需求、下單信，
 * 差別只在品項沒有商品庫存，改在 builder_place_class_order 同一交易內做名額預留。
 * 付款成功／取消／逾期的副作用全部走既有 onOrderPaid／cancel hooks（見各模組的 registerOrderHooks）。
 */

export const classContactInput = z
  .object({
    name: text(80),
    email: emailSchema,
    phone: z.string().trim().min(6, { message: "請填寫電話" }).max(40),
  })
  .strict();
export type ClassContact = z.output<typeof classContactInput>;

/** 課程類訂單不寄送實體商品：shipping 欄位存聯絡人（訂單表 shipping 不可為空） */
export const NO_SHIPPING_ADDRESS = "（活動／預約／線上課程，無需寄送）";

export async function shopActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("shop");
}

export interface ClassCheckoutInput {
  tenant: TenantRow;
  member: MemberRow | null;
  contact: ClassContact;
  item: ClassOrderItem;
  reservation: ClassReservation;
  paymentMethod: PaymentMethod;
  couponCode?: string | null;
  referralCode?: string | null;
  invoice?: unknown;
  note?: string | null;
  allowSandbox?: boolean;
  /** 保留不得晚於這個時間（例如場次／預約開始前），null = 不限 */
  holdUntilMax?: Date | null;
}

/** 付款前保留時間至少要這麼長，否則不接受付費報名（距離開始太近） */
export const MIN_HOLD_MS = 10 * 60_000;

export async function placeClassOrder(deps: CheckoutDeps, input: ClassCheckoutInput): Promise<{ order: OrderRow; accessKey: string; orderUrl: string; reservationId: string | null }> {
  const { tenant, member, item } = input;
  if (!(await shopActive(deps.store, tenant.id))) throw new ServiceError("invalid", "這個網站尚未開放線上收費（需要啟用 shop 模組），目前只能報名免費項目");
  const settings = await publishedShopSettings(deps.store, tenant);
  if (settings.allowGuestCheckout === false && !member) throw new ServiceError("unauthorized", "此網站需要先登入會員才能付款");
  if (item.line_total <= 0) throw new ServiceError("invalid", "免費項目不需要建立訂單");
  if (item.line_total > MAX_ORDER_TOTAL) throw new ServiceError("invalid", "單筆金額超過上限");
  const promo = await applyPromotions(deps.store, tenant, { subtotal: item.line_total, couponCode: input.couponCode, referralCode: input.referralCode, member, email: input.contact.email });
  const total = item.line_total - promo.discount;
  const avail = await paymentAvailability(deps.store, tenant, settings, { allowSandbox: input.allowSandbox });
  if (input.paymentMethod === "pchomepay") {
    if (!avail.pchomepay) throw new ServiceError("invalid", "此網站目前無法使用線上付款，請選擇其他付款方式");
    if (total < PCHOMEPAY_MIN_AMOUNT) throw new ServiceError("invalid", `線上付款最低金額為 NT$${PCHOMEPAY_MIN_AMOUNT}，請改用其他付款方式`);
  } else if (!avail.offline) {
    throw new ServiceError("invalid", "此網站未開放線下匯款");
  }
  const invoiceRequest = await resolveInvoiceRequest(deps.store, tenant, input.invoice);
  // 保留時間：線上刷卡 onlinePaymentHoldMinutes；線下匯款 orderExpireHours（與商店相同）——但不晚於開始時間
  const hours = input.paymentMethod === "pchomepay" ? (settings.onlinePaymentHoldMinutes ?? DEFAULT_ONLINE_HOLD_MINUTES) / 60 : (settings.orderExpireHours ?? 72);
  let expires = Date.now() + hours * 3600_000;
  if (input.holdUntilMax) expires = Math.min(expires, input.holdUntilMax.getTime());
  if (expires - Date.now() < MIN_HOLD_MS) throw new ServiceError("invalid", "距離開始時間太近，已無法線上付款報名，請直接聯絡店家");
  const accessKey = randomBytes(24).toString("base64url");
  const { id, reservation_id } = await deps.store.placeClassOrder(
    tenant.id,
    {
      order_prefix: settings.orderPrefix ?? defaultOrderPrefix(tenant.slug),
      member_id: member?.id ?? null,
      contact: input.contact,
      shipping: { name: input.contact.name, phone: input.contact.phone, address: NO_SHIPPING_ADDRESS },
      subtotal: item.line_total,
      total,
      payment_method: input.paymentMethod,
      expires_at: new Date(expires).toISOString(),
      access_key_hash: sha256(accessKey),
      note: input.note ?? null,
      discount_total: promo.discount,
      coupon: promo.coupon,
      referral_code: promo.referralCode,
      invoice_request: invoiceRequest,
    },
    [item],
    taipeiDay(),
    input.reservation,
  );
  const order = (await deps.store.getOrderById(tenant.id, id))!;
  const orderUrl = orderPageUrl(deps.baseUrl, tenant, order.order_no, accessKey);
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: member ? `member:${member.id}` : "guest", action: "order.place", payload: { orderNo: order.order_no, total: order.total, method: input.paymentMethod, kind: item.item_kind } });
  if (input.paymentMethod === "offline") await sendOrderPlacedMails(deps, tenant, order, settings, orderUrl);
  return { order, accessKey, orderUrl, reservationId: reservation_id };
}

/* ================================================================== 簽章連結（不存原文，伺服器可重算） */

function secret(): string {
  const v = process.env.PREVIEW_SECRET;
  if (!v || v.length < 8) throw new Error("環境變數 PREVIEW_SECRET 未設定或太短");
  return v;
}

/** HMAC(PREVIEW_SECRET, purpose:id) → base64url。用在簽到碼、候補保留連結、預約自助管理連結 */
export function signFor(purpose: string, id: string, len = 32): string {
  return createHmac("sha256", secret()).update(`${purpose}:${id}`).digest("base64url").slice(0, len);
}

export function verifySigned(purpose: string, id: string, token: unknown, len = 32): boolean {
  if (typeof token !== "string" || token.length !== len) return false;
  const want = Buffer.from(signFor(purpose, id, len));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 簽到碼：HMAC 衍生的 10 碼（去掉易混淆字元），DB 只存 sha256 */
export function checkinCode(registrationId: string): string {
  const h = createHmac("sha256", secret()).update(`checkin:${registrationId}`).digest();
  let s = "";
  for (let i = 0; i < 10; i++) s += B32[h[i]! % B32.length];
  return s;
}
export const checkinHash = (code: string) => sha256(`checkin:${code.trim().toUpperCase()}`);

/* ================================================================== 個資遮罩與 CSV */

export function maskName(n: string): string {
  const c = [...n.trim()];
  if (c.length <= 1) return "＊";
  if (c.length === 2) return `${c[0]}＊`;
  return `${c[0]}${"＊".repeat(Math.min(3, c.length - 2))}${c[c.length - 1]}`;
}
export function maskEmail(e: string): string {
  const [local, domain] = e.split("@");
  if (!domain) return "＊＊＊";
  return `${(local ?? "").slice(0, 2)}＊＊＊@${domain}`;
}
export function maskPhone(p: string): string {
  const d = p.replace(/\s/g, "");
  if (d.length <= 6) return "＊＊＊";
  return `${d.slice(0, 4)}＊＊＊${d.slice(-3)}`;
}
export const maskContact = (c: { name: string; email: string; phone: string }) => ({ name: maskName(c.name), email: maskEmail(c.email), phone: maskPhone(c.phone) });

/**
 * CSV 儲存格：🔴 防 CSV injection——以 = + - @ 開頭（以及 Tab、CR）的值前面加單引號，Excel／Sheets 不會當公式執行；
 * 一律加雙引號、內部雙引號重複。
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  // 開頭 BOM：Excel 開 UTF-8 中文不會亂碼
  return `﻿${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/* ================================================================== 時間（Asia/Taipei，固定 UTC+8、無夏令時間） */

export const TPE_OFFSET_MS = 8 * 3600_000;
/** 台北日期 YYYY-MM-DD */
export function taipeiDate(d: Date | number): string {
  return new Date(new Date(d).getTime() + TPE_OFFSET_MS).toISOString().slice(0, 10);
}
/** 台北日期＋分鐘數（0–1440）→ UTC 時刻 */
export function taipeiAt(date: string, minutes: number): Date {
  return new Date(Date.parse(`${date}T00:00:00+08:00`) + minutes * 60_000);
}
export function fmtTaipei(iso: string | Date, withWeekday = true): string {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", ...(withWeekday ? { weekday: "short" } : {}), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
export function fmtTaipeiTime(iso: string | Date): string {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
