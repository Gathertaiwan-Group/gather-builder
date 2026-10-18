import { z } from "zod";
import type { MemberRow, OrderRow, Store, TenantRow } from "../store/types";
import { loyaltySettings, tierSchema, type LoyaltySettings, type Tier } from "@/modules/loyalty/manifest";
import { ServiceError, activeModuleIds, audit, loadDraft, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { registerOrderHooks, type CancelDeps, type HookDeps } from "./order-hooks";
import { configureModule } from "./modules";
import { computeLedgerState } from "../loyalty/ledger";
import { taipeiDayStartIso } from "./loyalty-time";
import { DEFAULT_POINTS_EXPIRE_DAYS, DEFAULT_TIER_WINDOW_MONTHS, addDaysIso, earnPoints, merchandiseNet, sortedTiers, tierForSpend, tierWindowStart } from "../loyalty/rules";

/* ================================================================== 共用 */

export async function loyaltyActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("loyalty");
}
async function requireLoyalty(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await loyaltyActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「loyalty」，請先 enable_module loyalty");
}
export async function publishedLoyaltySettings(store: Store, tenant: TenantRow): Promise<LoyaltySettings> {
  return (await publishedModuleSettings(store, tenant, "loyalty")) as LoyaltySettings;
}
const isTopupOrder = (o: OrderRow) => o.items.some((i) => (i as { item_kind?: string }).item_kind === "topup");

/** 會員目前等級：快照超過 1 天（或沒有）就依期間消費重算 */
export async function currentTier(store: Store, tenant: TenantRow, member: MemberRow, s?: LoyaltySettings): Promise<Tier | null> {
  const settings = s ?? (await publishedLoyaltySettings(store, tenant));
  if (!settings.tiers?.length) return null;
  const row = await store.getMemberTier(tenant.id, member.id);
  if (row && Date.now() - new Date(row.evaluated_at).getTime() < 86400_000) return settings.tiers.find((t) => t.id === row.tier_id) ?? null;
  return (await evaluateTier(store, tenant, member.id, settings)).tier;
}

/** 依期間消費重算等級（升降級），變動時記稽核 */
export async function evaluateTier(store: Store, tenant: TenantRow, memberId: string, s?: LoyaltySettings): Promise<{ tier: Tier | null; spend: number; changed: boolean }> {
  const settings = s ?? (await publishedLoyaltySettings(store, tenant));
  const spend = await store.memberSpend(tenant.id, memberId, tierWindowStart(settings.tierWindowMonths));
  const tier = tierForSpend(settings.tiers, spend);
  const row = await store.getMemberTier(tenant.id, memberId);
  const changed = (row?.tier_id ?? null) !== (tier?.id ?? null);
  await store.upsertMemberTier({ tenant_id: tenant.id, member_id: memberId, tier_id: tier?.id ?? null, spend, changed });
  if (changed && (row || tier)) await store.insertAudit({ tenant_id: tenant.id, actor: "system:loyalty", action: "loyalty.tier_change", payload: { memberId, from: row?.tier_id ?? null, to: tier?.id ?? null, spend } });
  return { tier, spend, changed };
}

/* ================================================================== hooks：付款成功賺點、取消沖回 */

/**
 * 付款成功（只在真正轉成已付款那一次；sandbox 不跑）→ 依商品淨額（小計 − 折扣碼 − 等級折扣 − 點數折抵，不含運費）賺點。
 * 冪等：ref order:<id>:earn 唯一。儲值方案訂單不賺點（儲值金消費時才賺）。
 */
export async function onLoyaltyOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  if (!order.member_id || order.payment_sandbox || isTopupOrder(order)) return;
  if (!(await loyaltyActive(deps.store, tenant.id))) return;
  const s = await publishedLoyaltySettings(deps.store, tenant);
  const member = await deps.store.getMemberById(tenant.id, order.member_id);
  if (!member) return;
  const tier = await currentTier(deps.store, tenant, member, s);
  const base = merchandiseNet(order);
  const pts = earnPoints(base, s, tier?.multiplier ?? 1);
  if (pts > 0) {
    const r = await deps.store.creditPost("points", {
      tenantId: tenant.id,
      memberId: member.id,
      kind: "earn",
      amount: pts,
      expiresAt: addDaysIso(s.pointsExpireDays ?? DEFAULT_POINTS_EXPIRE_DAYS),
      ref: `order:${order.id}:earn`,
      orderId: order.id,
      reason: `訂單 ${order.order_no} 消費`,
      meta: { base, multiplier: tier?.multiplier ?? 1, tier: tier?.id ?? null },
      mode: "credit",
    });
    if (r.posted) await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:loyalty", action: "loyalty.earn", payload: { orderNo: order.order_no, points: pts } });
  }
  await evaluateTier(deps.store, tenant, member.id, s);
}

/**
 * 訂單取消（含付款後取消）：
 * - 折抵的點數已在 builder_cancel_order 同一交易退回（ref order:<id>:redeem_refund）。
 * - 這張訂單賺到的點數沖回（ref order:<id>:earn_reverse，冪等）。🔴 若點數已被用掉導致不足：**扣到 0 為止**，
 *   不足的部分記在分錄 meta.shortfall 與稽核 loyalty.reverse_shortfall（不讓餘額變負、不追討）。
 */
export async function onLoyaltyOrderCancelled(store: Store, tenant: TenantRow, order: OrderRow, _cd?: CancelDeps) {
  if (!order.member_id) return;
  const earned = await store.getCreditByRef("points", tenant.id, `order:${order.id}:earn`);
  if (earned) {
    const r = await store.creditPost("points", { tenantId: tenant.id, memberId: order.member_id, kind: "reverse", amount: -earned.amount, ref: `order:${order.id}:earn_reverse`, orderId: order.id, reason: `訂單 ${order.order_no} 取消，沖回點數`, mode: "capped" });
    const shortfall = earned.amount - Math.abs(r.amount);
    if (shortfall > 0 && (r.posted || r.amount === 0)) {
      await store.insertAudit({ tenant_id: tenant.id, actor: "system:loyalty", action: "loyalty.reverse_shortfall", payload: { orderNo: order.order_no, earned: earned.amount, reversed: Math.abs(r.amount), shortfall } });
    }
  }
  if (await loyaltyActive(store, tenant.id)) await evaluateTier(store, tenant, order.member_id);
}

registerOrderHooks({ name: "loyalty", paid: onLoyaltyOrderPaid, cancelled: onLoyaltyOrderCancelled });

/* ================================================================== 會員中心 */

export async function memberPointsView(store: Store, tenant: TenantRow, member: MemberRow) {
  const s = await publishedLoyaltySettings(store, tenant);
  const entries = await store.allCreditEntries("points", tenant.id, member.id);
  const st = computeLedgerState(entries);
  const tier = await currentTier(store, tenant, member, s);
  const row = await store.getMemberTier(tenant.id, member.id);
  const next = sortedTiers(s.tiers).find((t) => t.minSpend > (row?.spend ?? 0)) ?? null;
  return {
    balance: st.balance,
    available: st.available,
    expiring: st.lots.filter((l) => l.remaining > 0 && l.expiresAt && Date.parse(l.expiresAt) > Date.now()).slice(0, 5).map((l) => ({ points: l.remaining, expiresAt: l.expiresAt! })),
    tier,
    spend: row?.spend ?? 0,
    nextTier: next ? { name: next.name, need: next.minSpend - (row?.spend ?? 0) } : null,
    windowMonths: s.tierWindowMonths ?? DEFAULT_TIER_WINDOW_MONTHS,
    recent: entries.slice(-10).reverse().map((e) => ({ kind: e.kind, amount: e.amount, reason: e.reason, at: e.created_at, expiresAt: e.expires_at })),
  };
}

/* ================================================================== MCP／後台 */

async function findMember(ctx: ServiceContext, tenant: TenantRow, ref: { memberId?: string; email?: string }) {
  const m = ref.memberId ? await ctx.store.getMemberById(tenant.id, ref.memberId) : ref.email ? await ctx.store.getMemberByEmail(tenant.id, ref.email.trim().toLowerCase()) : null;
  if (!m) throw new ServiceError("not_found", "找不到會員（請給 memberId 或 email）");
  return m;
}

export async function getMemberPoints(ctx: ServiceContext, input: { site?: string | null; memberId?: string; email?: string }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireLoyalty(ctx, tenant);
  const m = await findMember(ctx, tenant, input);
  const v = await memberPointsView(ctx.store, tenant, m);
  const ledger = await ctx.store.listCreditLedger("points", tenant.id, m.id, 30);
  return {
    memberId: m.id,
    balance: v.balance,
    available: v.available,
    tier: v.tier ? { id: v.tier.id, name: v.tier.name } : null,
    spendInWindow: v.spend,
    expiring: v.expiring,
    ledger: ledger.map((e) => ({ kind: e.kind, amount: e.amount, expiresAt: e.expires_at, reason: e.reason, actor: e.actor, orderId: e.order_id, at: e.created_at, shortfall: (e.meta as { shortfall?: number }).shortfall ?? undefined })),
  };
}

export const adjustInput = z
  .object({
    amount: z.number().int().refine((n) => n !== 0, { message: "調整點數不可為 0" }).refine((n) => Math.abs(n) <= 1_000_000, { message: "單次調整上限 1,000,000 點" }),
    reason: z.string().trim().min(2, { message: "請填寫調整理由（至少 2 字）" }).max(200),
  })
  .strict();

/** 審查 M3：店主手動調整點數的預設上限（可在 loyalty 設定 adjustMaxPerCall／adjustMaxPerDay 調整） */
export const DEFAULT_POINTS_ADJUST_PER_CALL = 5_000;
export const DEFAULT_POINTS_ADJUST_PER_DAY = 20_000;


/**
 * 店主調整點數（審查 M3：專用 scope points:adjust＋confirm＋理由；單次與每日上限；全部寫稽核）。
 * 加點有到期日（同設定天數）；扣點不能超過可用（不會變負）。members:write 不再能調整點數。
 */
export async function adjustPoints(ctx: ServiceContext, input: { site?: string | null; memberId?: string; email?: string; amount: number; reason: string; confirm?: boolean }) {
  requireScope(ctx, "points:adjust");
  const tenant = await resolveTenant(ctx, input.site);
  await requireLoyalty(ctx, tenant);
  const d = parse(adjustInput, { amount: input.amount, reason: input.reason });
  const m = await findMember(ctx, tenant, input);
  const s = await publishedLoyaltySettings(ctx.store, tenant);
  const perCall = s.adjustMaxPerCall ?? DEFAULT_POINTS_ADJUST_PER_CALL;
  const perDay = s.adjustMaxPerDay ?? DEFAULT_POINTS_ADJUST_PER_DAY;
  const reject = async (why: string) => {
    await audit(ctx, tenant.id, "loyalty.adjust_rejected", { memberId: m.id, amount: d.amount, reason: d.reason, why });
    throw new ServiceError("invalid", why);
  };
  if (Math.abs(d.amount) > perCall) await reject(`單次調整上限 ${perCall} 點（loyalty 設定 adjustMaxPerCall）`);
  const today = await ctx.store.sumCreditKindSince("points", tenant.id, "adjust", taipeiDayStartIso());
  if (today + Math.abs(d.amount) > perDay) await reject(`今日手動調整已達 ${today} 點，再調 ${Math.abs(d.amount)} 點會超過每日上限 ${perDay} 點（loyalty 設定 adjustMaxPerDay）`);
  if (input.confirm !== true) throw new ServiceError("confirm_required", `${d.amount > 0 ? "加" : "扣"} ${Math.abs(d.amount)} 點給 ${m.email}（理由：${d.reason}）會寫入只增不改的點數帳本（今日已調整 ${today}／上限 ${perDay} 點）。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const r = await ctx.store.creditPost("points", {
    tenantId: tenant.id,
    memberId: m.id,
    kind: "adjust",
    amount: d.amount,
    expiresAt: d.amount > 0 ? addDaysIso(s.pointsExpireDays ?? DEFAULT_POINTS_EXPIRE_DAYS) : null,
    reason: d.reason,
    actor: ctx.actor.label,
    mode: d.amount > 0 ? "credit" : "strict",
  });
  await audit(ctx, tenant.id, "loyalty.adjust", { memberId: m.id, amount: d.amount, reason: d.reason });
  return { memberId: m.id, adjusted: r.amount, balance: r.balance };
}

export async function listTiers(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireLoyalty(ctx, tenant);
  const published = await publishedLoyaltySettings(ctx.store, tenant);
  const draft = loyaltySettings.safeParse((await loadDraft(ctx, tenant)).moduleSettings?.loyalty ?? {});
  const rows = await ctx.store.listMemberTiers(tenant.id, 5000);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.tier_id ?? "(一般)"] = (counts[r.tier_id ?? "(一般)"] ?? 0) + 1;
  return {
    published: sortedTiers(published.tiers),
    draft: draft.success ? sortedTiers(draft.data.tiers) : null,
    windowMonths: published.tierWindowMonths ?? DEFAULT_TIER_WINDOW_MONTHS,
    memberCounts: counts,
    note: "等級依「最近 windowMonths 個月已付款的商品淨額」計算；付款／取消時即時重算，每日 cron 處理降級。改等級用 update_tiers（進草稿，發布後生效）。",
  };
}

export async function updateTiers(ctx: ServiceContext, input: { site?: string | null; tiers: unknown; windowMonths?: number }) {
  requireScope(ctx, "modules:write");
  const tiers = parse(z.array(tierSchema).max(10), input.tiers);
  const config: Record<string, unknown> = { tiers };
  if (input.windowMonths !== undefined) config.tierWindowMonths = input.windowMonths;
  const r = await configureModule(ctx, { site: input.site, moduleId: "loyalty", config });
  return { ...r, tiers: sortedTiers(tiers) };
}

/* ================================================================== cron */

/** 每日：到期點數寫 expire（最近 35 天內到期的批次）、所有有等級快照的會員重算（降級） */
export async function runLoyaltyCron(store: Store, now = new Date()) {
  let expired = 0;
  for (const m of await store.listCreditMembersWithExpiry("points", new Date(now.getTime() - 35 * 86400_000).toISOString(), now.toISOString(), 500)) {
    expired += await store.creditExpire("points", m.tenant_id, m.member_id);
  }
  let evaluated = 0;
  let changed = 0;
  for (const t of await store.listTenants()) {
    if (!(await loyaltyActive(store, t.id))) continue;
    const s = await publishedLoyaltySettings(store, t);
    if (!s.tiers?.length) continue;
    for (const row of await store.listMemberTiers(t.id, 1000)) {
      const r = await evaluateTier(store, t, row.member_id, s);
      evaluated++;
      if (r.changed) changed++;
    }
  }
  return { expired, evaluated, changed };
}
