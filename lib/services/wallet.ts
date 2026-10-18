import { z } from "zod";
import type { MemberRow, OrderRow, PaymentMethod, Store, TenantRow, TopupPlanRow } from "../store/types";
import type { StoredValueSettings } from "@/modules/stored-value/manifest";
import { optText, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, publishedShopSettings, twd, type CheckoutDeps } from "./shop";
import { registerOrderHooks, type CancelDeps, type HookDeps } from "./order-hooks";
import { placeClassOrder } from "./class-orders";
import { computeLedgerState } from "../loyalty/ledger";
import { addDaysIso } from "../loyalty/rules";
import { taipeiDayStartIso } from "./loyalty-time";

/* ================================================================== 共用 */

export async function walletActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("stored-value");
}
async function requireWallet(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await walletActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「stored-value」，請先 enable_module stored-value");
}
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請維持 draft。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

/* ================================================================== 儲值方案 */

export const planInput = z
  .object({
    name: text(80),
    /** 付多少（NT$，30 起：線上付款最低金額） */
    payAmount: z.number().int().min(30).max(1_000_000),
    /** 另外贈送多少額度 */
    bonusAmount: z.number().int().min(0).max(1_000_000).default(0),
    /** 贈送額度幾天後到期（不填＝不到期）。本金不到期 */
    bonusExpireDays: z.number().int().min(1).max(3650).nullable().optional(),
    description: optText(500),
    status: z.enum(["draft", "published"]).default("draft"),
    sort: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

const planSummary = (p: TopupPlanRow) => ({
  id: p.id,
  name: p.name,
  payAmount: p.pay_amount,
  bonusAmount: p.bonus_amount,
  creditTotal: p.pay_amount + p.bonus_amount,
  bonusExpireDays: p.bonus_expire_days,
  description: p.description,
  status: p.status,
  sort: p.sort,
});

export async function createTopupPlan(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof planInput>) {
  requireScope(ctx, "commerce:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireWallet(ctx, tenant);
  const d = parse(planInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架儲值方案", confirm);
  if (d.bonusAmount === 0 && d.bonusExpireDays) throw new ServiceError("invalid", "沒有贈送額度時不需要設定 bonusExpireDays");
  const row = await ctx.store.insertTopupPlan({ tenant_id: tenant.id, name: d.name, pay_amount: d.payAmount, bonus_amount: d.bonusAmount, bonus_expire_days: d.bonusExpireDays ?? null, description: d.description ?? null, status: d.status, sort: d.sort });
  await audit(ctx, tenant.id, "wallet.plan_create", { planId: row.id, payAmount: row.pay_amount, bonus: row.bonus_amount, status: row.status });
  return { ...planSummary(row), note: row.status === "published" ? "已上架（立即對外）。" : "方案為草稿，status 改為 published（需 confirm）才會上架。" };
}

export async function updateTopupPlan(ctx: ServiceContext, input: { site?: string | null; planId: string; confirm?: boolean; patch: Partial<z.input<typeof planInput>> }) {
  requireScope(ctx, "commerce:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireWallet(ctx, tenant);
  const cur = await ctx.store.getTopupPlan(tenant.id, input.planId);
  if (!cur) throw new ServiceError("not_found", "找不到儲值方案");
  const p = parse(planInput.partial().strict(), input.patch ?? {});
  const next = input.patch?.status ?? cur.status;
  if (cur.status === "published" || next === "published") requireLiveConfirm(ctx, "修改／上架／下架儲值方案", input.confirm);
  const patch: Partial<TopupPlanRow> = {};
  if (input.patch.name !== undefined) patch.name = p.name;
  if (input.patch.payAmount !== undefined) patch.pay_amount = p.payAmount;
  if (input.patch.bonusAmount !== undefined) patch.bonus_amount = p.bonusAmount;
  if (input.patch.bonusExpireDays !== undefined) patch.bonus_expire_days = p.bonusExpireDays ?? null;
  if (input.patch.description !== undefined) patch.description = p.description ?? null;
  if (input.patch.status !== undefined) patch.status = p.status;
  if (input.patch.sort !== undefined) patch.sort = p.sort;
  const row = (await ctx.store.updateTopupPlan(tenant.id, cur.id, patch))!;
  await audit(ctx, tenant.id, "wallet.plan_update", { planId: row.id, keys: Object.keys(input.patch) });
  return planSummary(row);
}

export async function listTopupPlans(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireWallet(ctx, tenant);
  return { plans: (await ctx.store.listTopupPlans(tenant.id, {})).map(planSummary) };
}

export async function publicTopupPlans(store: Store, tenant: TenantRow) {
  return (await store.listTopupPlans(tenant.id, { status: "published" })).map(planSummary);
}

/* ================================================================== 購買（走既有訂單＋付款） */

export const buyTopupInput = z
  .object({
    planId: z.string().trim().min(1).max(64),
    contact: z.object({ name: text(80), phone: z.string().trim().min(6, { message: "請填寫電話" }).max(40) }).strict(),
    paymentMethod: z.enum(["offline", "pchomepay"]).optional(),
  })
  .strict();

/**
 * 購買儲值方案：必須登入會員（儲值金綁會員）。建立 item_kind=topup 的訂單（不能用折扣碼、點數、儲值金），
 * 付款真正成功那一次（onOrderPaid 的 hook，sandbox 不跑）才入帳——本金不到期、贈送額度依方案到期。
 */
export async function buyTopup(deps: CheckoutDeps, input: { tenant: TenantRow; member: MemberRow | null; data: unknown; allowSandbox?: boolean }) {
  const { tenant, member } = input;
  if (!(await walletActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放儲值");
  if (!member) throw new ServiceError("unauthorized", "請先登入會員再儲值（儲值金綁定會員帳號）");
  const d = parse(buyTopupInput, input.data);
  const plan = await deps.store.getTopupPlan(tenant.id, d.planId);
  if (!plan || plan.status !== "published") throw new ServiceError("not_found", "找不到這個儲值方案");
  const r = await placeClassOrder(deps, {
    tenant,
    member,
    contact: { name: d.contact.name, email: member.email, phone: d.contact.phone },
    item: {
      item_kind: "topup",
      ref_id: plan.id,
      name: `儲值：${plan.name}`,
      variant_label: plan.bonus_amount ? `得 ${twd(plan.pay_amount + plan.bonus_amount)}` : null,
      sku: null,
      unit_price: plan.pay_amount,
      qty: 1,
      line_total: plan.pay_amount,
      // 審查 M1：方案快照（入帳只讀快照；店主事後改方案不影響已下的單）
      snapshot: { planName: plan.name, payAmount: plan.pay_amount, bonusAmount: plan.bonus_amount, bonusExpireDays: plan.bonus_expire_days },
    },
    reservation: null,
    paymentMethod: (d.paymentMethod ?? "offline") as PaymentMethod,
    allowSandbox: input.allowSandbox,
  });
  return { order: r.order, accessKey: r.accessKey, orderUrl: r.orderUrl };
}

/* ================================================================== hooks：付款成功入帳、取消收回 */

type TopupSnapshot = { planName?: string; payAmount?: number; bonusAmount?: number; bonusExpireDays?: number | null };
const topupItems = (o: OrderRow) => o.items.filter((i) => (i as { item_kind?: string }).item_kind === "topup") as (OrderRow["items"][number] & { ref_id?: string; snapshot?: TopupSnapshot })[];

/** 付款成功（真正轉成已付款那一次；sandbox 不跑）→ 入帳本金＋贈送額度（ref 冪等） */
export async function onWalletOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  const items = topupItems(order);
  if (!items.length || order.payment_sandbox) return;
  if (!order.member_id) throw new Error(`儲值訂單 ${order.order_no} 沒有會員，無法入帳（需人工處理）`);
  for (const it of items) {
    // 審查 M1：入帳讀「下單時的方案快照」。2026-10-19 以前的訂單沒有快照 → 退回讀現行方案（並記稽核）
    const snap = it.snapshot;
    const plan = snap ? null : it.ref_id ? await deps.store.getTopupPlan(tenant.id, it.ref_id) : null;
    if (!snap) await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:wallet", action: "wallet.topup_no_snapshot", payload: { orderNo: order.order_no, planId: it.ref_id ?? null } });
    const planName = snap?.planName ?? plan?.name ?? "";
    const base = it.line_total;
    const bonus = snap ? Math.max(0, Math.floor(Number(snap.bonusAmount ?? 0))) : (plan?.bonus_amount ?? 0);
    const bonusDays = snap ? (snap.bonusExpireDays ?? null) : (plan?.bonus_expire_days ?? null);
    const a = await deps.store.creditPost("wallet", { tenantId: tenant.id, memberId: order.member_id, kind: "topup", amount: base, ref: `order:${order.id}:topup`, orderId: order.id, reason: `儲值 ${planName}`.trim(), meta: { planId: it.ref_id ?? null }, mode: "credit" });
    if (bonus > 0) {
      await deps.store.creditPost("wallet", { tenantId: tenant.id, memberId: order.member_id, kind: "topup", amount: bonus, expiresAt: bonusDays ? addDaysIso(bonusDays) : null, ref: `order:${order.id}:bonus`, orderId: order.id, reason: `儲值贈送 ${planName}`.trim(), meta: { planId: it.ref_id ?? null, bonus: true }, mode: "credit" });
    }
    if (!a.posted) continue;
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:wallet", action: "wallet.topup", payload: { orderNo: order.order_no, amount: base, bonus } });
    const st = await deps.store.creditState("wallet", tenant.id, order.member_id);
    await mailSafe(deps, order.contact.email, `【${tenant.name}】儲值成功 ${twd(base + bonus)}`, `${order.contact.name} 你好，\n\n訂單 ${order.order_no} 已付款，儲值金已入帳 ${twd(base)}${bonus ? `，另贈 ${twd(bonus)}${bonusDays ? `（${bonusDays} 天後到期）` : ""}` : ""}。\n目前儲值金餘額：${twd(st.balance)}\n結帳時可選擇用儲值金付款。`);
    const owner = ((await publishedModuleSettings(deps.store, tenant, "stored-value")) as StoredValueSettings).ownerEmail ?? (await publishedShopSettings(deps.store, tenant)).ownerEmail;
    if (owner) await mailSafe(deps, owner, `【${tenant.name}】會員儲值 ${twd(base)}（${order.order_no}）`, `會員儲值 ${twd(base)}${bonus ? `＋贈送 ${twd(bonus)}` : ""}。儲值金屬預收款，請依規定處理。`);
  }
}

/**
 * 儲值訂單取消（含已付款後取消）→ 收回這張訂單入帳的本金＋贈送（ref order:<id>:topup_reverse，冪等）。
 * 🔴 已經用掉一部分：只收回到餘額 0 為止（不讓餘額變負），不足部分記 meta.shortfall 與稽核 wallet.reverse_shortfall，
 * 由店家與客人另行處理（例如退款時扣除已使用金額）。儲值金「消費」訂單的取消退回由 SQL 同交易處理（refund）。
 */
export async function onWalletOrderCancelled(store: Store, tenant: TenantRow, order: OrderRow, _cd?: CancelDeps) {
  if (!order.member_id || !topupItems(order).length) return;
  const base = await store.getCreditByRef("wallet", tenant.id, `order:${order.id}:topup`);
  if (!base) return;
  const bonus = await store.getCreditByRef("wallet", tenant.id, `order:${order.id}:bonus`);
  const want = base.amount + (bonus?.amount ?? 0);
  const r = await store.creditPost("wallet", { tenantId: tenant.id, memberId: order.member_id, kind: "reverse", amount: -want, ref: `order:${order.id}:topup_reverse`, orderId: order.id, reason: `儲值訂單 ${order.order_no} 取消，收回儲值金`, mode: "capped" });
  const got = Math.abs(r.amount);
  if (got < want && (r.posted || r.amount === 0)) {
    await store.insertAudit({ tenant_id: tenant.id, actor: "system:wallet", action: "wallet.reverse_shortfall", payload: { orderNo: order.order_no, topup: want, reversed: got, shortfall: want - got } });
  }
}

registerOrderHooks({ name: "wallet", paid: onWalletOrderPaid, cancelled: onWalletOrderCancelled });

/**
 * 審查 M2：取消已入帳的儲值訂單前的試算——入帳多少、客人已用掉多少、取消可收回多少、不足多少。
 * 沒有入帳（未付款／非儲值訂單）回 null。收回規則同 onWalletOrderCancelled（capped：只收回到可用為 0）。
 */
export async function topupReversalPreview(store: Store, tenant: TenantRow, order: OrderRow): Promise<{ credited: number; used: number; reclaimable: number; shortfall: number } | null> {
  if (!order.member_id || !topupItems(order).length) return null;
  const base = await store.getCreditByRef("wallet", tenant.id, `order:${order.id}:topup`);
  if (!base) return null;
  if (await store.getCreditByRef("wallet", tenant.id, `order:${order.id}:topup_reverse`)) return null;
  const bonus = await store.getCreditByRef("wallet", tenant.id, `order:${order.id}:bonus`);
  const credited = base.amount + (bonus?.amount ?? 0);
  const st = await store.creditState("wallet", tenant.id, order.member_id);
  const reclaimable = Math.max(0, Math.min(credited, st.available));
  return { credited, used: credited - reclaimable, reclaimable, shortfall: credited - reclaimable };
}

export function topupReversalText(p: { credited: number; used: number; reclaimable: number; shortfall: number }) {
  return p.shortfall > 0
    ? `這張儲值訂單入帳 ${twd(p.credited)}，客人已用掉（或目前不可用）${twd(p.used)}：取消只能收回 ${twd(p.reclaimable)}，不足 ${twd(p.shortfall)} 無法收回。退款時請只退可收回的 ${twd(p.reclaimable)}（扣除已使用金額），或與客人另行協調。`
    : `這張儲值訂單入帳 ${twd(p.credited)}，取消會全額收回 ${twd(p.reclaimable)}。`;
}

/* ================================================================== 會員中心、MCP */

export async function memberWalletView(store: Store, tenant: TenantRow, member: MemberRow) {
  const entries = await store.allCreditEntries("wallet", tenant.id, member.id);
  const st = computeLedgerState(entries);
  return {
    balance: st.balance,
    available: st.available,
    expiring: st.lots.filter((l) => l.remaining > 0 && l.expiresAt && Date.parse(l.expiresAt) > Date.now()).slice(0, 5).map((l) => ({ amount: l.remaining, expiresAt: l.expiresAt! })),
    recent: entries.slice(-10).reverse().map((e) => ({ kind: e.kind, amount: e.amount, reason: e.reason, at: e.created_at })),
  };
}

async function findMember(ctx: ServiceContext, tenant: TenantRow, ref: { memberId?: string; email?: string }) {
  const m = ref.memberId ? await ctx.store.getMemberById(tenant.id, ref.memberId) : ref.email ? await ctx.store.getMemberByEmail(tenant.id, ref.email.trim().toLowerCase()) : null;
  if (!m) throw new ServiceError("not_found", "找不到會員（請給 memberId 或 email）");
  return m;
}

export async function getMemberBalance(ctx: ServiceContext, input: { site?: string | null; memberId?: string; email?: string }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireWallet(ctx, tenant);
  const m = await findMember(ctx, tenant, input);
  const v = await memberWalletView(ctx.store, tenant, m);
  const ledger = await ctx.store.listCreditLedger("wallet", tenant.id, m.id, 30);
  return {
    memberId: m.id,
    balance: v.balance,
    available: v.available,
    expiringBonus: v.expiring,
    ledger: ledger.map((e) => ({ kind: e.kind, amount: e.amount, expiresAt: e.expires_at, reason: e.reason, actor: e.actor, orderId: e.order_id, at: e.created_at, shortfall: (e.meta as { shortfall?: number }).shortfall ?? undefined })),
  };
}

const adjustInput = z
  .object({
    amount: z.number().int().refine((n) => n !== 0, { message: "調整金額不可為 0" }).refine((n) => Math.abs(n) <= 1_000_000, { message: "單次調整上限 NT$1,000,000" }),
    reason: z.string().trim().min(2, { message: "請填寫調整理由（至少 2 字）" }).max(200),
  })
  .strict();

/** 審查 M3：店主手動調整儲值金的預設上限（可在 stored-value 設定 adjustMaxPerCall／adjustMaxPerDay 調整） */
export const DEFAULT_WALLET_ADJUST_PER_CALL = 3_000;
export const DEFAULT_WALLET_ADJUST_PER_DAY = 10_000;

/**
 * 店主調整儲值金（審查 M3：專用 scope wallet:adjust＋confirm＋理由；單次與每日上限；全部寫稽核）。
 * 扣款不能超過可用（不會變負）。members:write 不再能調整儲值金。
 */
export async function adjustBalance(ctx: ServiceContext, input: { site?: string | null; memberId?: string; email?: string; amount: number; reason: string; confirm?: boolean }) {
  requireScope(ctx, "wallet:adjust");
  const tenant = await resolveTenant(ctx, input.site);
  await requireWallet(ctx, tenant);
  const d = parse(adjustInput, { amount: input.amount, reason: input.reason });
  const m = await findMember(ctx, tenant, input);
  const s = (await publishedModuleSettings(ctx.store, tenant, "stored-value")) as StoredValueSettings;
  const perCall = s.adjustMaxPerCall ?? DEFAULT_WALLET_ADJUST_PER_CALL;
  const perDay = s.adjustMaxPerDay ?? DEFAULT_WALLET_ADJUST_PER_DAY;
  const reject = async (why: string) => {
    await audit(ctx, tenant.id, "wallet.adjust_rejected", { memberId: m.id, amount: d.amount, reason: d.reason, why });
    throw new ServiceError("invalid", why);
  };
  if (Math.abs(d.amount) > perCall) await reject(`單次調整上限 ${twd(perCall)}（stored-value 設定 adjustMaxPerCall）`);
  const today = await ctx.store.sumCreditKindSince("wallet", tenant.id, "adjust", taipeiDayStartIso());
  if (today + Math.abs(d.amount) > perDay) await reject(`今日手動調整已達 ${twd(today)}，再調 ${twd(Math.abs(d.amount))} 會超過每日上限 ${twd(perDay)}（stored-value 設定 adjustMaxPerDay）`);
  if (input.confirm !== true) throw new ServiceError("confirm_required", `${d.amount > 0 ? "增加" : "扣除"}會員 ${m.email} 的儲值金 ${twd(Math.abs(d.amount))}（理由：${d.reason}）會寫入只增不改的儲值帳本（今日已調整 ${twd(today)}／上限 ${twd(perDay)}）。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const r = await ctx.store.creditPost("wallet", { tenantId: tenant.id, memberId: m.id, kind: "adjust", amount: d.amount, reason: d.reason, actor: ctx.actor.label, mode: d.amount > 0 ? "credit" : "strict" });
  await audit(ctx, tenant.id, "wallet.adjust", { memberId: m.id, amount: d.amount, reason: d.reason });
  return { memberId: m.id, adjusted: r.amount, balance: r.balance };
}

/** 每日：贈送額度到期 */
export async function runWalletCron(store: Store, now = new Date()) {
  let expired = 0;
  for (const m of await store.listCreditMembersWithExpiry("wallet", new Date(now.getTime() - 35 * 86400_000).toISOString(), now.toISOString(), 500)) {
    expired += await store.creditExpire("wallet", m.tenant_id, m.member_id);
  }
  return { expired };
}
