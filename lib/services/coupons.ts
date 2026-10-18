import { z } from "zod";
import type { CouponRow, MemberRow, Store, TenantRow } from "../store/types";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { twd } from "./shop";
import { normalizeEmail } from "../email-normalize";

/* ================================================================== 計算（server 端唯一依據） */

export const normalizeCode = (c: string) => c.trim().toUpperCase();

/**
 * 每人次數的識別（M-3）：一律用「正規化後的 email」——會員用自己帳號的 email、訪客用結帳 email，
 * 所以會員與訪客用同一個信箱（含 +tag、gmail 加點）視為同一人。仍無法防止不同信箱的同一個人（已知限制）。
 */
export function couponUserKey(member: MemberRow | null, email: string) {
  return `email:${normalizeEmail(member ? member.email : email)}`;
}

/** 2026-10 以前的每人鍵（會員 = member:<id>）：舊的使用次數記在這裡，檢查時一併算進去 */
export function legacyCouponUserKey(member: MemberRow | null, email: string) {
  return member ? `member:${member.id}` : `email:${email.trim().toLowerCase()}`;
}

/** 折扣金額：固定金額不超過小計；百分比無條件捨去且不超過 max_discount 與小計 */
export function couponDiscount(c: Pick<CouponRow, "kind" | "value" | "max_discount">, subtotal: number): number {
  if (subtotal <= 0) return 0;
  if (c.kind === "fixed") return Math.min(c.value, subtotal);
  const raw = Math.floor((subtotal * c.value) / 100);
  return Math.max(0, Math.min(raw, c.max_discount ?? 0, subtotal));
}

export type CouponCheck = { ok: true; coupon: CouponRow; discount: number } | { ok: false; message: string };

/**
 * 友善檢查（給試算與下單前的錯誤訊息）。🔴 權威檢查在 builder_place_order：同一交易內原子扣總次數與每人次數，
 * 併發也不會超用；這裡通過不代表一定扣得到。
 */
export async function checkCoupon(store: Store, tenant: TenantRow, input: { code: string; subtotal: number; member: MemberRow | null; email: string; now?: number }): Promise<CouponCheck> {
  const c = await store.getCouponByCode(tenant.id, normalizeCode(input.code));
  const t = input.now ?? Date.now();
  if (!c || !c.active) return { ok: false, message: "折扣碼無效" };
  if (c.starts_at && new Date(c.starts_at).getTime() > t) return { ok: false, message: "折扣碼尚未開始" };
  if (c.ends_at && new Date(c.ends_at).getTime() <= t) return { ok: false, message: "折扣碼已過期" };
  if (c.max_uses !== null && c.used_count >= c.max_uses) return { ok: false, message: "折扣碼已被用完" };
  if (input.subtotal < c.min_subtotal) return { ok: false, message: `未達最低消費 ${twd(c.min_subtotal)}` };
  if (c.assigned_member_id && c.assigned_member_id !== input.member?.id) return { ok: false, message: "這張折扣碼限指定會員使用，請先登入" };
  if (c.per_user_limit !== null) {
    const key = couponUserKey(input.member, input.email);
    const legacy = legacyCouponUserKey(input.member, input.email);
    const used = (await store.getCouponUserCount(c.id, key)) + (legacy !== key ? await store.getCouponUserCount(c.id, legacy) : 0);
    if (used >= c.per_user_limit) return { ok: false, message: "你已達這張折扣碼的使用次數上限" };
  }
  return { ok: true, coupon: c, discount: couponDiscount(c, input.subtotal) };
}

/* ================================================================== 管理（MCP／後台） */

async function requireCoupons(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("coupons")) throw new ServiceError("forbidden", "此網站未啟用模組「coupons」，請先 enable_module coupons");
}

export const couponInput = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/, { message: "折扣碼需為 3–32 碼英數或 - _" }),
    kind: z.enum(["fixed", "percent"]),
    /** fixed：折抵金額（NT$）；percent：折扣百分比（1–100，例如 15 = 打 85 折） */
    value: z.number().int().min(1).max(10_000_000),
    /** 百分比券必填：最多折多少（NT$） */
    maxDiscount: z.number().int().min(1).max(10_000_000).optional(),
    minSubtotal: z.number().int().min(0).max(10_000_000).default(0),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    perUserLimit: z.number().int().min(1).max(1000).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.kind === "percent" && (c.value > 100 || c.value < 1)) ctx.addIssue({ code: "custom", path: ["value"], message: "百分比需為 1–100" });
    if (c.kind === "percent" && !c.maxDiscount) ctx.addIssue({ code: "custom", path: ["maxDiscount"], message: "百分比折扣一定要設定折抵上限 maxDiscount" });
    if (c.startsAt && c.endsAt && new Date(c.endsAt) <= new Date(c.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "結束時間要晚於開始時間" });
  });

export function couponSummary(c: CouponRow) {
  return {
    id: c.id,
    code: c.code,
    kind: c.kind,
    value: c.value,
    maxDiscount: c.max_discount,
    minSubtotal: c.min_subtotal,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    maxUses: c.max_uses,
    usedCount: c.used_count,
    perUserLimit: c.per_user_limit,
    active: c.active,
    source: c.source,
    assignedMemberId: c.assigned_member_id,
    note: c.note,
  };
}

export async function createCoupon(ctx: ServiceContext, input: { site?: string | null } & z.input<typeof couponInput>) {
  requireScope(ctx, "marketing:write");
  const { site, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireCoupons(ctx, tenant);
  const d = parse(couponInput, rest);
  if (await ctx.store.getCouponByCode(tenant.id, d.code)) throw new ServiceError("conflict", `折扣碼「${d.code}」已存在`);
  const row = await ctx.store.insertCoupon({
    tenant_id: tenant.id,
    code: d.code,
    kind: d.kind,
    value: d.value,
    max_discount: d.maxDiscount ?? null,
    min_subtotal: d.minSubtotal,
    starts_at: d.startsAt ?? null,
    ends_at: d.endsAt ?? null,
    max_uses: d.maxUses ?? null,
    per_user_limit: d.perUserLimit ?? null,
    assigned_member_id: null,
    active: true,
    source: "manual",
    note: d.note ?? null,
  });
  await audit(ctx, tenant.id, "coupon.create", { code: row.code, kind: row.kind, value: row.value });
  return { ...couponSummary(row), note: "折扣碼已建立並立即可用（客人在結帳頁輸入）。" };
}

export async function updateCoupon(ctx: ServiceContext, input: { site?: string | null; code: string; active?: boolean; endsAt?: string | null; maxUses?: number | null; perUserLimit?: number | null; note?: string }) {
  requireScope(ctx, "marketing:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCoupons(ctx, tenant);
  const c = await ctx.store.getCouponByCode(tenant.id, normalizeCode(input.code));
  if (!c) throw new ServiceError("not_found", `找不到折扣碼「${input.code}」`);
  const patch: Parameters<Store["updateCoupon"]>[2] = {};
  if (input.active !== undefined) patch.active = input.active;
  if (input.endsAt !== undefined) patch.ends_at = input.endsAt === null ? null : parse(z.iso.datetime({ offset: true }), input.endsAt);
  if (input.maxUses !== undefined) patch.max_uses = input.maxUses === null ? null : parse(z.number().int().min(1), input.maxUses);
  if (input.perUserLimit !== undefined) patch.per_user_limit = input.perUserLimit === null ? null : parse(z.number().int().min(1), input.perUserLimit);
  if (input.note !== undefined) patch.note = input.note.slice(0, 200);
  const row = (await ctx.store.updateCoupon(tenant.id, c.id, patch))!;
  await audit(ctx, tenant.id, "coupon.update", { code: c.code, keys: Object.keys(patch) });
  return couponSummary(row);
}

export async function listCoupons(ctx: ServiceContext, input: { site?: string | null; active?: boolean; limit?: number; offset?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCoupons(ctx, tenant);
  const r = await ctx.store.listCoupons(tenant.id, { active: input.active, limit: Math.max(1, Math.min(100, input.limit ?? 50)), offset: Math.max(0, input.offset ?? 0) });
  return { total: r.total, coupons: r.rows.map(couponSummary) };
}
