import type { LoyaltySettings, Tier } from "@/modules/loyalty/manifest";

/** 點數規則的純函式（server 計價與單元測試共用） */
export const DEFAULT_EARN_PER_AMOUNT = 100;
export const DEFAULT_POINT_VALUE = 1;
export const DEFAULT_MAX_REDEEM_PERCENT = 50;
export const DEFAULT_POINTS_EXPIRE_DAYS = 365;
export const DEFAULT_TIER_WINDOW_MONTHS = 12;

/**
 * 訂單的「商品實付淨額」＝小計 − 折扣碼 − 等級折扣 − 點數折抵（不含運費；儲值金是付款方式不扣）。
 * 賺點、等級消費（SQL builder_member_spend）、KOL 分潤（審查 M4）一律用這個基數。
 */
export function merchandiseNet(o: { subtotal: number; discount_total?: number | null; tier_discount?: number | null; points_discount?: number | null }): number {
  return Math.max(0, o.subtotal - (o.discount_total ?? 0) - (o.tier_discount ?? 0) - (o.points_discount ?? 0));
}

export function sortedTiers(tiers: Tier[] | undefined): Tier[] {
  return [...(tiers ?? [])].sort((a, b) => a.minSpend - b.minSpend);
}

/** 期間消費 → 等級（最高的、門檻 ≤ 消費者）；沒有任何一級回 null（一般會員） */
export function tierForSpend(tiers: Tier[] | undefined, spend: number): Tier | null {
  let hit: Tier | null = null;
  for (const t of sortedTiers(tiers)) if (spend >= t.minSpend) hit = t;
  return hit;
}

/** 賺點：floor(商品淨額 / 每 X 元) × 等級倍率（再 floor）。淨額 ≤ 0 得 0 */
export function earnPoints(base: number, s: Pick<LoyaltySettings, "earnPerAmount">, multiplier = 1): number {
  if (base <= 0) return 0;
  return Math.floor(Math.floor(base / (s.earnPerAmount ?? DEFAULT_EARN_PER_AMOUNT)) * multiplier);
}

/** 等級折扣（商品金額 × %，無條件捨去） */
export function tierDiscount(merchandise: number, tier: Tier | null): number {
  if (!tier || !tier.discountPercent || merchandise <= 0) return 0;
  return Math.floor((merchandise * tier.discountPercent) / 100);
}

/**
 * 點數折抵上限（點）：商品金額（扣等級折扣後）× maxRedeemPercent ÷ pointValue（無條件捨去）。
 * 實際可用＝min(想用的、上限、可用點數)。
 */
export function maxRedeemablePoints(merchandiseAfterTier: number, s: Pick<LoyaltySettings, "maxRedeemPercent" | "pointValue" | "redeemEnabled">): number {
  if (s.redeemEnabled === false || merchandiseAfterTier <= 0) return 0;
  const cap = Math.floor((merchandiseAfterTier * (s.maxRedeemPercent ?? DEFAULT_MAX_REDEEM_PERCENT)) / 100);
  return Math.floor(cap / (s.pointValue ?? DEFAULT_POINT_VALUE));
}

export function addDaysIso(days: number, from = Date.now()): string {
  return new Date(from + days * 86400_000).toISOString();
}

/** 等級期間的起點（0 ＝ 累計全部 → null） */
export function tierWindowStart(months: number | undefined, now = new Date()): string | null {
  const m = months ?? DEFAULT_TIER_WINDOW_MONTHS;
  if (!m) return null;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString();
}
