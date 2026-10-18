import { randomBytes } from "node:crypto";
import type { MemberRow, OrderRow, ReferralCodeRow, Store, TenantRow } from "../store/types";
import type { ReferralSettings } from "@/modules/referral/manifest";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { publishedModuleSettings } from "./members";
import { registerOrderHooks, type HookDeps } from "./order-hooks";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(len: number, prefix = "") {
  const buf = randomBytes(len);
  let s = prefix;
  for (const b of buf) s += ALPHA[b % ALPHA.length];
  return s.slice(0, prefix.length + len);
}

export async function referralActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("referral");
}

/** 會員自己的推薦碼（沒有就建一組；碼唯一，碰撞重試） */
export async function getOrCreateReferralCode(store: Store, tenant: TenantRow, member: MemberRow): Promise<ReferralCodeRow> {
  const existing = await store.getReferralCodeByMember(tenant.id, member.id);
  if (existing) return existing;
  for (let i = 0; i < 5; i++) {
    const row = await store.insertReferralCode({ tenant_id: tenant.id, member_id: member.id, code: randomCode(8) });
    if (row) return row;
    const again = await store.getReferralCodeByMember(tenant.id, member.id); // 併發時另一個請求已建好
    if (again) return again;
  }
  throw new Error("無法產生推薦碼");
}

export function shareUrl(baseUrl: string, tenant: Pick<TenantRow, "slug">, code: string) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/api/ref/${code}`;
}

const refereeKey = (o: OrderRow) => (o.member_id ? `member:${o.member_id}` : `email:${o.contact.email.toLowerCase()}`);

/**
 * 付款成功的副作用（訂單 paid 轉換成功那一次呼叫；本身也冪等）：
 * 1. KOL 分潤：推薦碼有設比例 → 記一筆 earn（同一訂單只會一筆，unique(order_id, kind)）。
 * 2. 首次付款回饋：被推薦人在本站沒有其他已付款訂單 → 寫 builder_referrals（unique(tenant, referee_key)，同一人只一次）→ 發回饋券給推薦人。
 * 不能自己推薦自己：推薦人＝下單會員，或 email 相同 → 全部略過。
 */
export async function onReferralOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  if (!order.referral_code || !(await referralActive(deps.store, tenant.id))) return;
  const rc = await deps.store.getReferralCodeByCode(tenant.id, order.referral_code);
  if (!rc) return;
  const referrer = await deps.store.getMemberById(tenant.id, rc.member_id);
  if (!referrer || referrer.status !== "active") return;
  if (order.member_id === referrer.id || order.contact.email.toLowerCase() === referrer.email.toLowerCase()) return;
  const settings = (await publishedModuleSettings(deps.store, tenant, "referral")) as Partial<ReferralSettings>;

  if (rc.kol_rate_bp > 0 && settings.kolEnabled !== false) {
    const base = Math.max(0, order.subtotal - (order.discount_total ?? 0));
    const amount = Math.floor((base * rc.kol_rate_bp) / 10000);
    if (amount > 0 && (await deps.store.insertLedger({ tenant_id: tenant.id, referrer_member_id: referrer.id, order_id: order.id, kind: "earn", amount }))) {
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:referral", action: "referral.earn", payload: { orderNo: order.order_no, code: rc.code, amount } });
    }
  }

  if (!settings.rewardCoupon) return;
  const prior = await deps.store.countPaidOrdersFor(tenant.id, { memberId: order.member_id, email: order.contact.email }, order.id);
  if (prior > 0) return;
  const ref = await deps.store.insertReferral({ tenant_id: tenant.id, referrer_member_id: referrer.id, referee_key: refereeKey(order), referee_member_id: order.member_id, order_id: order.id });
  if (!ref) return; // 這個被推薦人已觸發過
  const rw = settings.rewardCoupon;
  const coupon = await deps.store.insertCoupon({
    tenant_id: tenant.id,
    code: randomCode(10, "RF"),
    kind: rw.kind,
    value: rw.value,
    max_discount: rw.kind === "percent" ? (rw.maxDiscount ?? null) : null,
    min_subtotal: rw.minSubtotal ?? 0,
    starts_at: null,
    ends_at: new Date(Date.now() + (rw.validDays ?? 90) * 86400_000).toISOString(),
    max_uses: 1,
    per_user_limit: 1,
    assigned_member_id: referrer.id,
    active: true,
    source: "referral",
    note: `推薦回饋（訂單 ${order.order_no}）`,
  });
  await deps.store.setReferralReward(tenant.id, ref.id, coupon.id);
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:referral", action: "referral.reward", payload: { orderNo: order.order_no, referrer: referrer.id, coupon: coupon.code } });
  if (deps.sendMail) {
    try {
      await deps.sendMail(
        referrer.email,
        `【${tenant.name}】感謝推薦！送你一張回饋券`,
        `${referrer.name ?? ""} 你好，\n\n你推薦的朋友完成了第一筆訂單，送你一張回饋券：${coupon.code}（${rw.kind === "fixed" ? `折 NT$${rw.value}` : `${rw.value}% 折扣`}，${rw.validDays ?? 90} 天內有效，限本人登入使用）。\n\n${deps.baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/shop`,
      );
    } catch (e) {
      console.error("[referral] 寄回饋通知失敗", e instanceof Error ? e.message : e);
    }
  }
}

/** 訂單取消：有分潤 earn 就記一筆 reverse（只增不改；unique(order_id, kind) 保證只沖一次） */
export async function onReferralOrderCancelled(store: Store, tenant: TenantRow, order: OrderRow) {
  const earned = (await store.listLedger(tenant.id, { orderId: order.id, limit: 5 })).find((l) => l.kind === "earn");
  if (!earned) return;
  if (await store.insertLedger({ tenant_id: tenant.id, referrer_member_id: earned.referrer_member_id, order_id: order.id, kind: "reverse", amount: -earned.amount })) {
    await store.insertAudit({ tenant_id: tenant.id, actor: "system:referral", action: "referral.reverse", payload: { orderNo: order.order_no, amount: -earned.amount } });
  }
}

registerOrderHooks({ paid: onReferralOrderPaid, cancelled: onReferralOrderCancelled });

/* ================================================================== 後台＋MCP */

async function requireReferral(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await referralActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「referral」，請先 enable_module referral");
}

/** 推薦報表：每位推薦人的推薦碼、KOL 比例、成功推薦數、分潤（earn − reverse） */
export async function listReferrals(ctx: ServiceContext, input: { site?: string | null; limit?: number }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireReferral(ctx, tenant);
  const lim = Math.max(1, Math.min(200, input.limit ?? 100));
  const [refs, ledger] = await Promise.all([ctx.store.listReferrals(tenant.id, { limit: 500, offset: 0 }), ctx.store.listLedger(tenant.id, { limit: 2000 })]);
  const byReferrer = new Map<string, { referrals: number; earned: number; reversed: number }>();
  for (const r of refs.rows) {
    const b = byReferrer.get(r.referrer_member_id) ?? { referrals: 0, earned: 0, reversed: 0 };
    b.referrals++;
    byReferrer.set(r.referrer_member_id, b);
  }
  for (const l of ledger) {
    const b = byReferrer.get(l.referrer_member_id) ?? { referrals: 0, earned: 0, reversed: 0 };
    if (l.kind === "earn") b.earned += l.amount;
    else b.reversed += l.amount;
    byReferrer.set(l.referrer_member_id, b);
  }
  const rows = await Promise.all(
    [...byReferrer.entries()].slice(0, lim).map(async ([memberId, b]) => {
      const [m, code] = await Promise.all([ctx.store.getMemberById(tenant.id, memberId), ctx.store.getReferralCodeByMember(tenant.id, memberId)]);
      return { memberId, email: m?.email ?? null, code: code?.code ?? null, kolRatePercent: code ? code.kol_rate_bp / 100 : 0, referrals: b.referrals, commission: b.earned + b.reversed, earned: b.earned, reversed: b.reversed };
    }),
  );
  return {
    totalReferrals: refs.total,
    referrers: rows,
    recentLedger: ledger.slice(0, 50).map((l) => ({ memberId: l.referrer_member_id, orderId: l.order_id, kind: l.kind, amount: l.amount, at: l.created_at })),
  };
}

/** 設定某會員推薦碼的 KOL 分潤比例（百分比，0 = 不分潤，上限 50） */
export async function setReferralKol(ctx: ServiceContext, input: { site?: string | null; memberId?: string; email?: string; ratePercent: number }) {
  requireScope(ctx, "marketing:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireReferral(ctx, tenant);
  if (!Number.isFinite(input.ratePercent) || input.ratePercent < 0 || input.ratePercent > 50) throw new ServiceError("invalid", "分潤比例需為 0–50（%）");
  const m = input.memberId ? await ctx.store.getMemberById(tenant.id, input.memberId) : input.email ? await ctx.store.getMemberByEmail(tenant.id, input.email.trim().toLowerCase()) : null;
  if (!m) throw new ServiceError("not_found", "找不到會員（請給 memberId 或 email）");
  const code = await getOrCreateReferralCode(ctx.store, tenant, m);
  const row = (await ctx.store.updateReferralCode(tenant.id, code.id, { kol_rate_bp: Math.round(input.ratePercent * 100) }))!;
  await audit(ctx, tenant.id, "referral.kol", { memberId: m.id, bp: row.kol_rate_bp });
  return { memberId: m.id, email: m.email, code: row.code, kolRatePercent: row.kol_rate_bp / 100, shareUrl: shareUrl(ctx.baseUrl, tenant, row.code) };
}
