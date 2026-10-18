import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { MemberRow, Store, SubscriptionPlanRow, SubscriptionRow, SubscriptionStatus, TenantRow } from "../store/types";
import type { SubscriptionsSettings } from "@/modules/subscriptions/manifest";
import { text, optText } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, publishedShopSettings, twd } from "./shop";
import { maskEmail } from "./class-common";
import { providerFromAccount } from "../pay/registry";
import type { NewebpayProvider } from "../pay/newebpay";
import { intAmount, parseBody, taipeiFormat } from "../pay/crypto";
import { payToken, verifyPayToken } from "../pay/notify-token";
import type { Mailer } from "../mail";

/**
 * 訂閱制（定期扣款）。第一個 provider：藍新信用卡定期定額（NDNP 手冊，建立委託 NPA-B05／每期授權通知 NPA-N050／
 * 修改委託狀態 NPA-B051／委託單查詢 NPA-B053）。
 *
 * 狀態機（只允許下列轉換，一律條件式更新）：
 *   pending ──建立成功──▶ active ──扣款失敗──▶ past_due ──寬限到期──▶ expired
 *      │                   │  ▲                  │
 *      │                   │  └──扣款成功────────┘
 *      └─建立失敗／放棄───▶ cancelled ◀──會員／店主取消（終止委託成功）── active／past_due
 *   active ──最後一期結束──▶ expired。cancelled、expired 是終點。
 * 🔴 每期扣款：通知（AES 解密＝持有金鑰才能產生）＋權威回查（委託單查詢 AlreadyTimes／狀態＋交易查詢）；
 *    同一期只入帳一次（builder_record_subscription_charge：unique(訂閱, 期數, 結果)＋同交易轉換狀態）。
 * 權益：active（含試用、寬限期）時開通；停權（expired）或取消後到期時收回（冪等：entitlement_state 條件更新）。
 */

export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  pending: ["active", "cancelled"],
  active: ["past_due", "cancelled", "expired"],
  past_due: ["active", "cancelled", "expired"],
  cancelled: [],
  expired: [],
};
export const canTransitionSubscription = (from: SubscriptionStatus, to: SubscriptionStatus) => SUBSCRIPTION_TRANSITIONS[from].includes(to);
const sourcesForSub = (to: SubscriptionStatus) => (Object.keys(SUBSCRIPTION_TRANSITIONS) as SubscriptionStatus[]).filter((f) => canTransitionSubscription(f, to));

export const DEFAULT_GRACE_DAYS = 7;
/** 每期到期日的緩衝（藍新授權可能晚一點才通知） */
const PERIOD_SLACK_MS = 2 * 86400_000;
/** 終止委託重試上限 */
const CANCEL_MAX_ATTEMPTS = 10;

export interface SubDeps {
  store: Store;
  sendMail?: Mailer;
  baseUrl: string;
  /** 測試注入：依建立時環境取藍新 provider（預設讀 DB 憑證；環境不符回 null） */
  newebpayFor?: (tenantId: string, sandbox: boolean) => Promise<NewebpayProvider | null>;
}

export async function subscriptionsActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("subscriptions");
}
async function requireSubs(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await subscriptionsActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「subscriptions」，請先 enable_module subscriptions");
}
async function settingsFor(store: Store, tenant: TenantRow): Promise<SubscriptionsSettings> {
  return (await publishedModuleSettings(store, tenant, "subscriptions")) as SubscriptionsSettings;
}
async function ownerEmail(store: Store, tenant: TenantRow) {
  return (await settingsFor(store, tenant)).ownerEmail ?? (await publishedShopSettings(store, tenant)).ownerEmail;
}

async function newebpay(deps: SubDeps, tenantId: string, sandbox: boolean, opts: { requireVerified?: boolean } = {}): Promise<NewebpayProvider | null> {
  if (deps.newebpayFor) return deps.newebpayFor(tenantId, sandbox);
  const acct = await deps.store.getPaymentAccount(tenantId, "newebpay");
  if (!acct || acct.sandbox !== sandbox || (opts.requireVerified && acct.status !== "verified")) return null;
  return providerFromAccount(acct, tenantId) as NewebpayProvider;
}

/* ================================================================== 方案 */

export const planInput = z
  .object({
    name: text(80),
    /** 每期金額（NT$，30 起） */
    amount: z.number().int().min(30).max(2_000_000),
    interval: z.enum(["month", "year"]),
    /** 試用天數（0＝立即扣第一期；1–28：先做 10 元驗證，試用期後才扣第一期） */
    trialDays: z.number().int().min(0).max(28).default(0),
    /** 期數上限（藍新最多 99 期） */
    totalPeriods: z.number().int().min(1).max(99).default(99),
    /** 權益：none（純月費）或 course（開通某課程） */
    entitlement: z.union([z.object({ kind: z.literal("none") }).strict(), z.object({ kind: z.literal("course"), courseId: z.string().trim().min(1).max(64) }).strict()]).default({ kind: "none" }),
    description: optText(2000),
    status: z.enum(["draft", "active", "archived"]).default("draft"),
  })
  .strict();

const planSummary = (p: SubscriptionPlanRow) => ({ id: p.id, name: p.name, amount: p.amount, interval: p.interval, trialDays: p.trial_days, totalPeriods: p.total_periods, entitlement: p.entitlement, provider: p.provider, status: p.status, description: p.description });

function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請維持 draft。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

export async function createSubscriptionPlan(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof planInput>) {
  requireScope(ctx, "commerce:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireSubs(ctx, tenant);
  const d = parse(planInput, rest);
  if (d.status === "active") requireLiveConfirm(ctx, "直接上架訂閱方案", confirm);
  if (d.entitlement.kind === "course" && !(await ctx.store.getCourseById(tenant.id, d.entitlement.courseId))) throw new ServiceError("not_found", "找不到要開通的課程（entitlement.courseId）");
  const row = await ctx.store.insertSubscriptionPlan({ tenant_id: tenant.id, name: d.name, amount: d.amount, interval: d.interval, trial_days: d.trialDays, total_periods: d.totalPeriods, entitlement: d.entitlement, provider: "newebpay", status: d.status, description: d.description ?? "" });
  await audit(ctx, tenant.id, "subscription.plan_create", { planId: row.id, amount: row.amount, interval: row.interval, status: row.status });
  return { ...planSummary(row), note: row.status === "active" ? "方案已上架（立即對外）。" : "方案為草稿，status 改為 active（需 confirm）才會上架。" };
}

/** 方案只能改名稱、說明、上下架（金額、週期改了會讓既有委託與方案不一致 → 請建新方案） */
export async function updateSubscriptionPlan(ctx: ServiceContext, input: { site?: string | null; planId: string; name?: string; description?: string; status?: "draft" | "active" | "archived"; confirm?: boolean }) {
  requireScope(ctx, "commerce:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireSubs(ctx, tenant);
  const cur = await ctx.store.getSubscriptionPlan(tenant.id, input.planId);
  if (!cur) throw new ServiceError("not_found", "找不到訂閱方案");
  const next = input.status ?? cur.status;
  if (cur.status === "active" || next === "active") requireLiveConfirm(ctx, "修改／上架／下架訂閱方案", input.confirm);
  const patch: Partial<Pick<SubscriptionPlanRow, "name" | "description" | "status">> = {};
  if (input.name !== undefined) patch.name = parse(text(80), input.name);
  if (input.description !== undefined) patch.description = parse(z.string().max(2000), input.description);
  if (input.status !== undefined) patch.status = parse(z.enum(["draft", "active", "archived"]), input.status);
  const row = (await ctx.store.updateSubscriptionPlan(tenant.id, cur.id, patch))!;
  await audit(ctx, tenant.id, "subscription.plan_update", { planId: row.id, keys: Object.keys(patch) });
  return { ...planSummary(row), note: "既有訂閱不受影響（金額與週期以訂閱建立時為準）。" };
}

export async function listSubscriptionPlans(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireSubs(ctx, tenant);
  return { plans: (await ctx.store.listSubscriptionPlans(tenant.id, {})).map(planSummary) };
}

export async function publicSubscriptionPlans(store: Store, tenant: TenantRow) {
  return (await store.listSubscriptionPlans(tenant.id, { status: "active" })).map(planSummary);
}

/* ================================================================== 訂閱（會員） */

/** 藍新 MerOrderNo：英數＿≤30、同一商店不可重複 */
function genMerOrderNo() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let r = "";
  for (const b of randomBytes(12)) r += A[b % A.length];
  return `SB${Date.now().toString(36).toUpperCase()}${r}`.slice(0, 28);
}

/** 依週期與試用天數算藍新的 PeriodType／PeriodPoint／PeriodStartType 與第一期涵蓋到何時 */
export function periodPlan(interval: "month" | "year", trialDays: number, now = new Date()) {
  const first = new Date(now.getTime() + trialDays * 86400_000);
  const point = interval === "month" ? taipeiFormat(first, "dd") : taipeiFormat(first, "MMdd");
  return { periodType: interval === "month" ? ("M" as const) : ("Y" as const), periodPoint: point, startType: trialDays > 0 ? (1 as const) : (2 as const), firstChargeAt: first };
}

function addInterval(d: Date, interval: "month" | "year") {
  const x = new Date(d.getTime());
  if (interval === "month") x.setUTCMonth(x.getUTCMonth() + 1);
  else x.setUTCFullYear(x.getUTCFullYear() + 1);
  return x;
}

export const subscribeInput = z.object({ planId: z.string().trim().min(1).max(64) }).strict();

/**
 * 會員訂閱：建 pending 訂閱 → 產生藍新定期定額表單（瀏覽器自動送出）。必須登入會員；同一方案同時只能有一筆進行中的訂閱。
 * 🔴 sandbox（藍新測試環境）憑證只在帶有效預覽簽章時可用（同 shop H1）。
 */
export async function subscribe(deps: SubDeps, input: { tenant: TenantRow; member: MemberRow | null; data: unknown; allowSandbox?: boolean }) {
  const { tenant, member } = input;
  if (!(await subscriptionsActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放訂閱");
  if (!member || member.status !== "active") throw new ServiceError("unauthorized", "請先登入會員再訂閱");
  const d = parse(subscribeInput, input.data);
  const plan = await deps.store.getSubscriptionPlan(tenant.id, d.planId);
  if (!plan || plan.status !== "active") throw new ServiceError("not_found", "找不到這個訂閱方案");
  const acct = await deps.store.getPaymentAccount(tenant.id, "newebpay");
  if (!acct || acct.status !== "verified" || (acct.sandbox && input.allowSandbox !== true)) throw new ServiceError("invalid", "此網站目前無法線上訂閱（尚未設定藍新信用卡定期定額）");
  const provider = await newebpay(deps, tenant.id, acct.sandbox, { requireVerified: true });
  if (!provider) throw new ServiceError("invalid", "此網站目前無法線上訂閱");
  // 放棄的 pending（超過 1 小時沒完成）先作廢，讓會員可以重新訂閱
  for (const s of (await deps.store.listSubscriptions(tenant.id, { memberId: member.id, planId: plan.id, status: "pending", limit: 5, offset: 0 })).rows) {
    if (Date.parse(s.created_at) < Date.now() - 3600_000) await deps.store.transitionSubscription(tenant.id, s.id, ["pending"], "cancelled", { cancelled_at: new Date().toISOString(), ended_at: new Date().toISOString() });
  }
  let sub: SubscriptionRow;
  try {
    sub = await deps.store.insertSubscription({ tenant_id: tenant.id, plan_id: plan.id, member_id: member.id, provider: "newebpay", sandbox: acct.sandbox, merchant_order_no: genMerOrderNo(), amount: plan.amount, interval: plan.interval, total_periods: plan.total_periods });
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") throw new ServiceError("conflict", "你已經有這個方案的訂閱（或剛送出、尚在處理中），請到會員中心查看");
    throw e;
  }
  const pp = periodPlan(plan.interval, plan.trial_days);
  const base = deps.baseUrl.replace(/\/$/, "");
  const q = `s=${encodeURIComponent(sub.id)}&t=${payToken("notify", `sub:${sub.id}`)}`;
  const form = provider.buildPeriodForm({
    merOrderNo: sub.merchant_order_no,
    prodDesc: `${tenant.name} ${plan.name}`,
    amount: plan.amount,
    periodType: pp.periodType,
    periodPoint: pp.periodPoint,
    startType: pp.startType,
    times: plan.total_periods,
    notifyUrl: `${base}/api/subscriptions/newebpay/notify/${tenant.id}?${q}`,
    returnUrl: `${base}/api/subscriptions/newebpay/return/${tenant.id}?${q}`,
    backUrl: `${base}/s/${tenant.slug}/account`,
    payerEmail: member.email,
  });
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: `member:${member.id}`, action: "subscription.start", payload: { subscriptionId: sub.id, planId: plan.id, amount: plan.amount, sandbox: acct.sandbox } });
  return { subscription: sub, form: { kind: "form" as const, ...form } };
}

/* ================================================================== 藍新通知（建立結果＋每期授權） */

export type SubNotifyResult = { status: number; body: string; outcome: string };

/**
 * 藍新定期定額通知（NotifyURL；建立委託結果與每期授權結果都打這裡）。安全規則：
 * 1. 網址帶 tenantId＋訂閱 id＋HMAC token；訂閱的 tenant 必須相符。
 * 2. 定期定額沒有 TradeSha：用「該租戶自己的 HashKey／HashIV」AES 解密成功（嚴格 PKCS7）才算是藍新送的；
 *    MerchantID、MerOrderNo（＝訂閱）、PeriodNo（建立後）、金額都要相符。
 * 3. 一律權威回查：委託單查詢（NPA-B053：委託狀態、已授權期數 AlreadyTimes）＋交易查詢（QueryTradeInfo，查到時以它為準）。
 * 4. 每期只入帳一次（DB 唯一鍵）；回查失敗或狀態無法辨識 → 回 500 讓藍新重送、警示店主；處理完回 200（藍新只認 HTTP 200）。
 */
export async function handleSubscriptionNotify(deps: SubDeps, input: { tenantId: string; subscriptionId: string | null; token: string | null; rawBody: string; contentType: string }): Promise<SubNotifyResult> {
  const ok = (outcome: string) => ({ status: 200, body: "SUCCESS", outcome });
  const retry = (outcome: string) => ({ status: 500, body: "retry", outcome });
  const invalid = (outcome: string) => ({ status: 400, body: "invalid", outcome });
  if (!input.subscriptionId || !verifyPayToken("notify", `sub:${input.subscriptionId}`, input.token)) return invalid("bad_token");
  const tenant = await deps.store.getTenantById(input.tenantId);
  if (!tenant) return ok("unknown_tenant");
  const sub = await deps.store.getSubscription(tenant.id, input.subscriptionId);
  if (!sub) return ok("unknown_subscription");
  const provider = await newebpay(deps, tenant.id, sub.sandbox);
  if (!provider) return retry("no_provider");
  const p = parseBody(input.rawBody, input.contentType);
  // 正式站曾以 Period、Result 不同欄位名回傳（Dating UP 實測），都接受
  const hex = p.Period ?? p.period ?? p.Result ?? p.TradeInfo ?? "";
  let data: Record<string, unknown>;
  try {
    data = provider.decryptPeriod(hex);
  } catch {
    console.error(`[subscriptions/notify] 🔴 解密失敗（不是用這個商店的金鑰加密）tenant=${tenant.id} sub=${sub.id}`);
    return invalid("decrypt");
  }
  const r = (data.Result && typeof data.Result === "object" ? data.Result : {}) as Record<string, unknown>;
  const acct = await deps.store.getPaymentAccount(tenant.id, "newebpay");
  if (!acct || String(r.MerchantID ?? "") !== acct.app_id) return invalid("merchant");
  if (String(r.MerchantOrderNo ?? r.MerOrderNo ?? "") !== sub.merchant_order_no) return invalid("order_no");
  const periodNo = String(r.PeriodNo ?? "");
  if (sub.period_no && periodNo && periodNo !== sub.period_no) return invalid("period_no");
  const isCreation = r.AlreadyTimes === undefined && r.OrderNo === undefined;
  return isCreation ? onCreation(deps, tenant, sub, provider, data, r, ok, retry) : onPeriodCharge(deps, tenant, sub, provider, data, r, ok, retry);
}

type R = (o: string) => SubNotifyResult;

async function onCreation(deps: SubDeps, tenant: TenantRow, sub: SubscriptionRow, provider: NewebpayProvider, data: Record<string, unknown>, r: Record<string, unknown>, ok: R, retry: R) {
  if (sub.status !== "pending") return ok(`already:${sub.status}`);
  const plan = await deps.store.getSubscriptionPlan(tenant.id, sub.plan_id);
  if (String(data.Status) !== "SUCCESS") {
    await deps.store.transitionSubscription(tenant.id, sub.id, ["pending"], "cancelled", { cancelled_at: new Date().toISOString(), ended_at: new Date().toISOString() });
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "newebpay", action: "subscription.create_failed", payload: { subscriptionId: sub.id, status: data.Status } });
    return ok(`create_failed:${String(data.Status)}`);
  }
  const periodNo = String(r.PeriodNo ?? "");
  if (!periodNo || intAmount(r.PeriodAmt) !== sub.amount) return ok("mismatch");
  // 權威回查：委託單查詢
  const q = await provider.queryPeriod(sub.merchant_order_no, periodNo);
  const qr = (q?.Result ?? {}) as Record<string, unknown>;
  if (!q || String(q.Status) !== "SUCCESS") return queryFailed(deps, tenant, sub, "委託單查詢失敗", retry);
  const st = String(qr.Status ?? "");
  if (intAmount(qr.PeriodAmt) !== sub.amount || String(qr.PeriodNo ?? periodNo) !== periodNo) return ok("query_mismatch");
  if (st === "2" || st === "3") {
    await deps.store.transitionSubscription(tenant.id, sub.id, ["pending"], "cancelled", { period_no: periodNo, cancelled_at: new Date().toISOString(), ended_at: new Date().toISOString() });
    return ok(`create_failed:query_status_${st}`);
  }
  if (st !== "1") return queryFailed(deps, tenant, sub, `委託狀態無法辨識（${st}）`, retry, true);
  const now = new Date();
  const trial = (plan?.trial_days ?? 0) > 0;
  if (trial) {
    // 試用期：10 元驗證成功、還沒扣第一期 → 權益先開通到試用結束
    const end = new Date(now.getTime() + (plan!.trial_days * 86400_000) + PERIOD_SLACK_MS).toISOString();
    const moved = await deps.store.transitionSubscription(tenant.id, sub.id, ["pending"], "active", { period_no: periodNo, current_period_end: end, activated_at: now.toISOString() });
    if (moved) await afterActivated(deps, tenant, moved, "trial");
    return ok("active_trial");
  }
  // 立即扣第一期：建立結果帶授權資料（RespondCode 00）
  await deps.store.updateSubscriptionIf(tenant.id, sub.id, { status: "pending" }, { period_no: periodNo });
  if (String(r.RespondCode ?? "") !== "00") return ok("first_charge_not_ok");
  return recordCharge(deps, tenant, { ...sub, period_no: periodNo }, provider, 1, { amount: sub.amount, tradeNo: String(r.TradeNo ?? "") || null, raw: { create: r } }, ok, retry);
}

async function onPeriodCharge(deps: SubDeps, tenant: TenantRow, sub: SubscriptionRow, provider: NewebpayProvider, data: Record<string, unknown>, r: Record<string, unknown>, ok: R, retry: R) {
  const n = intAmount(r.AlreadyTimes);
  if (!n || n < 1 || n > sub.total_periods) return ok("bad_period_index");
  const orderNo = String(r.OrderNo ?? "");
  if (orderNo && orderNo !== `${sub.merchant_order_no}_${n}`) return ok("order_no_mismatch");
  if (!sub.period_no) return retry("not_activated_yet");
  const success = String(data.Status) === "SUCCESS" && String(r.RespondCode ?? "") === "00";
  if (intAmount(r.AuthAmt) !== sub.amount) return ok("amount_mismatch");
  // 權威回查 1：委託單查詢（已授權期數必須涵蓋這一期、委託狀態為扣款中／已到期）
  const q = await provider.queryPeriod(sub.merchant_order_no, sub.period_no);
  if (!q || String(q.Status) !== "SUCCESS") return queryFailed(deps, tenant, sub, "委託單查詢失敗", retry);
  const qr = (q.Result ?? {}) as Record<string, unknown>;
  const already = intAmount(qr.AlreadyTimes) ?? 0;
  const st = String(qr.Status ?? "");
  if (already < n) return ok("query_not_reached");
  if (intAmount(qr.PeriodAmt) !== sub.amount) return ok("query_amount_mismatch");
  if (!success) return recordCharge(deps, tenant, sub, provider, n, { amount: sub.amount, tradeNo: String(r.TradeNo ?? "") || null, raw: { notify: r }, failed: true }, ok, retry);
  if (st !== "1" && st !== "4") return queryFailed(deps, tenant, sub, `委託狀態 ${st}，與「本期授權成功」不一致`, retry, true);
  // 權威回查 2：交易查詢（藍新未明文保證每期可用 QueryTradeInfo 查到：查到就以它為準，查無才只依委託單查詢——列為已知風險）
  const t = await provider.queryRaw(orderNo || `${sub.merchant_order_no}_${n}`, sub.amount);
  if (t && String(t.Status) === "SUCCESS") {
    const tr = (t.Result ?? {}) as Record<string, unknown>;
    if (String(tr.TradeStatus) !== "1" || intAmount(tr.Amt) !== sub.amount) return queryFailed(deps, tenant, sub, `交易查詢與通知不一致（TradeStatus=${String(tr.TradeStatus)}）`, retry, true);
  }
  return recordCharge(deps, tenant, sub, provider, n, { amount: sub.amount, tradeNo: String(r.TradeNo ?? "") || null, raw: { notify: r, tradeQuery: t?.Status ?? null } }, ok, retry);
}

async function queryFailed(deps: SubDeps, tenant: TenantRow, sub: SubscriptionRow, reason: string, retry: R, alertNow = false) {
  const n = sub.query_failures + 1;
  await deps.store.updateSubscriptionIf(tenant.id, sub.id, {}, { query_failures: n });
  console.error(`[subscriptions] ${reason}（第 ${n} 次）sub=${sub.id}`);
  if ((alertNow || n >= 3) && (await deps.store.updateSubscriptionIf(tenant.id, sub.id, { alerted_at: null }, { alerted_at: new Date().toISOString() }))) {
    const owner = await ownerEmail(deps.store, tenant);
    if (owner) await mailSafe(deps, owner, `⚠️【${tenant.name}】訂閱扣款狀態無法確認`, `訂閱（委託編號 ${sub.merchant_order_no}）的扣款通知無法用藍新回查確認：${reason}\n系統不會入帳這一期，會持續等待藍新重送。請到藍新商店後台確認這張委託的授權紀錄。`);
  }
  return retry(`query_failed:${reason}`);
}

async function recordCharge(deps: SubDeps, tenant: TenantRow, sub: SubscriptionRow, _provider: NewebpayProvider, n: number, c: { amount: number; tradeNo: string | null; raw: Record<string, unknown>; failed?: boolean }, ok: R, _retry: R) {
  const settings = await settingsFor(deps.store, tenant);
  const now = new Date();
  const periodEnd = new Date(addInterval(now, sub.interval).getTime() + PERIOD_SLACK_MS).toISOString();
  const graceUntil = new Date(now.getTime() + (settings.graceDays ?? DEFAULT_GRACE_DAYS) * 86400_000).toISOString();
  const res = await deps.store.recordSubscriptionCharge(tenant.id, { subscriptionId: sub.id, periodIndex: n, amount: c.amount, status: c.failed ? "failed" : "paid", tradeNo: c.tradeNo, raw: c.raw, periodEnd, graceUntil });
  if (!res.inserted) return ok(`duplicate:${n}`);
  if (sub.query_failures) await deps.store.updateSubscriptionIf(tenant.id, sub.id, {}, { query_failures: 0 });
  const after = (await deps.store.getSubscription(tenant.id, sub.id))!;
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "newebpay", action: c.failed ? "subscription.charge_failed" : "subscription.charge", payload: { subscriptionId: sub.id, period: n, amount: c.amount, status: res.status } });
  const member = await deps.store.getMemberById(tenant.id, sub.member_id);
  const plan = await deps.store.getSubscriptionPlan(tenant.id, sub.plan_id);
  if (c.failed) {
    if (member) await mailSafe(deps, member.email, `【${tenant.name}】訂閱扣款失敗`, `${member.name ?? ""} 你好，\n\n「${plan?.name ?? "訂閱"}」第 ${n} 期扣款失敗。請在 ${taipeiFormat(new Date(after.grace_until ?? graceUntil), "yyyy/MM/dd")} 前確認信用卡可正常使用（藍新會依排程再扣款），逾期未成功將暫停會員權益。`);
    const owner = await ownerEmail(deps.store, tenant);
    if (owner) await mailSafe(deps, owner, `【${tenant.name}】訂閱扣款失敗（${maskEmail(member?.email ?? "")}）`, `「${plan?.name ?? "訂閱"}」第 ${n} 期扣款失敗，已進入寬限期。`);
    return ok(`charge_failed:${n}`);
  }
  if (res.status === "cancelled" || res.status === "expired") {
    // 已取消／停權後仍被扣款（例如終止委託失敗期間）→ 不恢復訂閱、警示店主退款
    const owner = await ownerEmail(deps.store, tenant);
    if (owner) await mailSafe(deps, owner, `🔴【${tenant.name}】已取消的訂閱仍被扣款，請人工退款`, `訂閱（委託編號 ${sub.merchant_order_no}）狀態為 ${res.status}，但藍新第 ${n} 期授權成功 ${twd(c.amount)}。請到藍新後台退款並確認委託已終止。`);
    return ok(`paid_after_end:${n}`);
  }
  await afterActivated(deps, tenant, after, `period_${n}`);
  if (member) await mailSafe(deps, member.email, `【${tenant.name}】訂閱扣款成功 ${twd(c.amount)}`, `${member.name ?? ""} 你好，\n\n「${plan?.name ?? "訂閱"}」第 ${n} 期已扣款 ${twd(c.amount)}，權益有效至 ${taipeiFormat(new Date(after.current_period_end ?? periodEnd), "yyyy/MM/dd")}。`);
  return ok(`charged:${n}`);
}

/* ================================================================== 權益（冪等） */

async function afterActivated(deps: SubDeps, tenant: TenantRow, sub: SubscriptionRow, why: string) {
  if (sub.entitlement_state === "granted") return;
  await grantEntitlement(deps.store, tenant, sub, why);
}

/** 開通權益（entitlement_state none／revoked → granted，條件式只成功一次） */
export async function grantEntitlement(store: Store, tenant: TenantRow, sub: SubscriptionRow, why = "grant") {
  const plan = await store.getSubscriptionPlan(tenant.id, sub.plan_id);
  for (const from of ["none", "revoked"] as const) {
    const claimed = await store.updateSubscriptionIf(tenant.id, sub.id, { entitlement_state: from }, { entitlement_state: "granted" });
    if (!claimed) continue;
    let ref: Record<string, unknown> | null = null;
    if (plan?.entitlement.kind === "course") {
      const g = await store.grantEnrollment(tenant.id, { courseId: plan.entitlement.courseId, memberId: sub.member_id, source: "subscription", orderId: null, by: `subscription:${sub.id}` });
      // 會員原本就有（買過或手動開通）→ 不記 ref，停權時不會收回他原本的權限
      ref = g.granted ? { enrollmentId: g.id } : null;
    }
    await store.updateSubscriptionIf(tenant.id, sub.id, {}, { entitlement_ref: ref });
    await store.insertAudit({ tenant_id: tenant.id, actor: "system:subscriptions", action: "subscription.entitle", payload: { subscriptionId: sub.id, why, ref } });
    return true;
  }
  return false;
}

/** 收回權益（granted → revoked，條件式只成功一次；只收回這筆訂閱開通的） */
export async function revokeEntitlement(store: Store, tenant: TenantRow, sub: SubscriptionRow, why: string) {
  const claimed = await store.updateSubscriptionIf(tenant.id, sub.id, { entitlement_state: "granted" }, { entitlement_state: "revoked" });
  if (!claimed) return false;
  const ref = sub.entitlement_ref as { enrollmentId?: string } | null;
  if (ref?.enrollmentId) await store.revokeEnrollment(tenant.id, { id: ref.enrollmentId }, { by: `subscription:${sub.id}`, reason: why });
  await store.insertAudit({ tenant_id: tenant.id, actor: "system:subscriptions", action: "subscription.revoke", payload: { subscriptionId: sub.id, why } });
  return true;
}

/** 其他模組可用：會員是否有有效訂閱（active 或寬限中，或已取消但仍在已付期間內） */
export async function hasActiveSubscription(store: Store, tenantId: string, memberId: string, planId?: string) {
  const rows = (await store.listSubscriptions(tenantId, { memberId, planId, limit: 50, offset: 0 })).rows;
  return rows.some((s) => s.entitlement_state === "granted" && (s.status === "active" || s.status === "past_due" || (s.status === "cancelled" && !!s.ended_at && Date.parse(s.ended_at) > Date.now())));
}

/* ================================================================== 取消 */

/**
 * 取消訂閱（會員中心或店主）：先終止藍新委託（NPA-B051 terminate），成功才轉 cancelled；權益保留到已付期間結束。
 * 終止失敗 → cancel_state failed、記錄錯誤與次數，每日 cron 重試（最多 10 次），第 3 次起警示店主。
 */
export async function requestCancel(deps: SubDeps, tenant: TenantRow, sub: SubscriptionRow, by: string): Promise<{ status: SubscriptionStatus; cancelState: SubscriptionRow["cancel_state"]; message: string }> {
  if (sub.status === "cancelled" || sub.status === "expired") return { status: sub.status, cancelState: sub.cancel_state, message: "這筆訂閱已經結束" };
  const nowIso = new Date().toISOString();
  if (sub.status === "pending" || !sub.period_no) {
    const moved = await deps.store.transitionSubscription(tenant.id, sub.id, ["pending"], "cancelled", { cancelled_at: nowIso, ended_at: nowIso, cancel_state: "done" });
    return { status: moved?.status ?? sub.status, cancelState: "done", message: "已取消（委託尚未建立）" };
  }
  await deps.store.updateSubscriptionIf(tenant.id, sub.id, {}, { cancel_state: "requested", cancel_requested_at: sub.cancel_requested_at ?? nowIso });
  const provider = await newebpay(deps, tenant.id, sub.sandbox);
  const r: { kind: "ok" | "already" } | { kind: "rejected" | "unknown"; message: string } = provider ? await provider.terminatePeriod(sub.merchant_order_no, sub.period_no) : { kind: "unknown", message: "沒有可用的藍新憑證（或環境與建立時不同）" };
  if (r.kind === "ok" || r.kind === "already") {
    const endAt = sub.status === "active" && sub.current_period_end ? sub.current_period_end : nowIso;
    const moved = await deps.store.transitionSubscription(tenant.id, sub.id, sourcesForSub("cancelled"), "cancelled", { cancel_state: "done", cancel_error: null, cancelled_at: nowIso, ended_at: endAt });
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: by, action: "subscription.cancel", payload: { subscriptionId: sub.id, endAt } });
    if (moved && Date.parse(endAt) <= Date.now()) await revokeEntitlement(deps.store, tenant, moved, "cancelled");
    const member = await deps.store.getMemberById(tenant.id, sub.member_id);
    if (member) await mailSafe(deps, member.email, `【${tenant.name}】訂閱已取消`, `${member.name ?? ""} 你好，\n\n你的訂閱已取消，之後不會再扣款。權益保留到 ${taipeiFormat(new Date(endAt), "yyyy/MM/dd")}。`);
    return { status: moved?.status ?? "cancelled", cancelState: "done", message: `已取消，之後不會再扣款；權益保留到 ${taipeiFormat(new Date(endAt), "yyyy/MM/dd")}` };
  }
  const msg: string = "message" in r ? r.message : "未知錯誤";
  const attempts = sub.cancel_attempts + 1;
  await deps.store.updateSubscriptionIf(tenant.id, sub.id, {}, { cancel_state: "failed", cancel_attempts: attempts, cancel_error: msg.slice(0, 300) });
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: by, action: "subscription.cancel_failed", payload: { subscriptionId: sub.id, attempts, message: msg.slice(0, 200) } });
  if (attempts >= 3) {
    const owner = await ownerEmail(deps.store, tenant);
    if (owner) await mailSafe(deps, owner, `⚠️【${tenant.name}】訂閱取消（終止藍新委託）連續失敗`, `委託編號 ${sub.merchant_order_no} 已連續 ${attempts} 次終止失敗：${msg}\n系統會每日重試；也請到藍新商店後台手動終止，避免繼續扣款。`);
  }
  return { status: sub.status, cancelState: "failed", message: `取消已送出，但終止藍新委託暫時失敗（${msg}）。系統會自動重試，完成後寄信通知。` };
}

export async function memberCancelSubscription(deps: SubDeps, input: { tenant: TenantRow; member: MemberRow | null; subscriptionId: string }) {
  if (!input.member) throw new ServiceError("unauthorized", "請先登入會員");
  const sub = await deps.store.getSubscription(input.tenant.id, input.subscriptionId);
  if (!sub || sub.member_id !== input.member.id) throw new ServiceError("not_found", "找不到這筆訂閱");
  return requestCancel(deps, input.tenant, sub, `member:${input.member.id}`);
}

export async function cancelSubscription(ctx: ServiceContext, input: { site?: string | null; subscriptionId: string; confirm?: boolean }) {
  requireScope(ctx, "members:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireSubs(ctx, tenant);
  const sub = await ctx.store.getSubscription(tenant.id, input.subscriptionId);
  if (!sub) throw new ServiceError("not_found", "找不到這筆訂閱");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `取消訂閱（${maskEmail((await ctx.store.getMemberById(tenant.id, sub.member_id))?.email ?? "")}，每期 ${twd(sub.amount)}）會終止藍新定期定額委託（無法再啟用），會員權益保留到已付期間結束。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const r = await requestCancel({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, sub, ctx.actor.label);
  await audit(ctx, tenant.id, "subscription.cancel_request", { subscriptionId: sub.id, result: r.cancelState });
  return r;
}

/* ================================================================== 列表（遮罩） */

function subSummary(s: SubscriptionRow, member: MemberRow | null, plan: SubscriptionPlanRow | null) {
  return {
    id: s.id,
    plan: plan ? { id: plan.id, name: plan.name } : { id: s.plan_id, name: null },
    member: member ? { id: member.id, email: maskEmail(member.email) } : { id: s.member_id, email: null },
    status: s.status,
    amount: s.amount,
    interval: s.interval,
    sandbox: s.sandbox,
    currentPeriodEnd: s.current_period_end,
    graceUntil: s.grace_until,
    failedCount: s.failed_count,
    cancelState: s.cancel_state,
    cancelError: s.cancel_error,
    entitlement: s.entitlement_state,
    createdAt: s.created_at,
    endedAt: s.ended_at,
  };
}

export async function listSubscriptions(ctx: ServiceContext, input: { site?: string | null; status?: SubscriptionStatus; planId?: string; limit?: number; offset?: number }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireSubs(ctx, tenant);
  const r = await ctx.store.listSubscriptions(tenant.id, { status: input.status, planId: input.planId, limit: Math.max(1, Math.min(100, input.limit ?? 50)), offset: Math.max(0, input.offset ?? 0) });
  const plans = new Map((await ctx.store.listSubscriptionPlans(tenant.id, {})).map((p) => [p.id, p]));
  const out = [];
  for (const s of r.rows) out.push(subSummary(s, await ctx.store.getMemberById(tenant.id, s.member_id), plans.get(s.plan_id) ?? null));
  return { total: r.total, subscriptions: out, note: "會員 email 遮罩。" };
}

export async function memberSubscriptions(store: Store, tenant: TenantRow, member: MemberRow) {
  const r = await store.listSubscriptions(tenant.id, { memberId: member.id, limit: 20, offset: 0 });
  const plans = new Map((await store.listSubscriptionPlans(tenant.id, {})).map((p) => [p.id, p]));
  return r.rows.filter((s) => s.status !== "pending" || Date.parse(s.created_at) > Date.now() - 3600_000).map((s) => subSummary(s, member, plans.get(s.plan_id) ?? null));
}

/* ================================================================== 每日 cron（寬限到期停權、應扣未扣、取消重試、放棄的 pending） */

export async function sweepSubscriptions(deps: SubDeps, now = new Date()) {
  const nowIso = now.toISOString();
  const out = { expired: 0, pastDue: 0, revoked: 0, cancelRetried: 0, abandoned: 0 };
  for (const s of await deps.store.listSubscriptionsForSweep(nowIso, 200)) {
    const tenant = await deps.store.getTenantById(s.tenant_id);
    if (!tenant) continue;
    if ((s.cancel_state === "requested" || s.cancel_state === "failed") && s.status !== "cancelled" && s.status !== "expired" && s.cancel_attempts < CANCEL_MAX_ATTEMPTS) {
      await requestCancel(deps, tenant, s, "system:cron");
      out.cancelRetried++;
      continue;
    }
    if (s.status === "pending" && Date.parse(s.created_at) <= now.getTime() - 3600_000) {
      if (await deps.store.transitionSubscription(tenant.id, s.id, ["pending"], "cancelled", { cancelled_at: nowIso, ended_at: nowIso })) out.abandoned++;
      continue;
    }
    if (s.status === "past_due" && s.grace_until && s.grace_until <= nowIso) {
      const moved = await deps.store.transitionSubscription(tenant.id, s.id, ["past_due"], "expired", { ended_at: nowIso });
      if (moved) {
        out.expired++;
        if (await revokeEntitlement(deps.store, tenant, moved, "grace_expired")) out.revoked++;
        const member = await deps.store.getMemberById(tenant.id, s.member_id);
        if (member) await mailSafe(deps, member.email, `【${tenant.name}】訂閱已停權`, `${member.name ?? ""} 你好，\n\n因扣款一直未成功，你的訂閱已停權。若要繼續使用請重新訂閱。`);
      }
      continue;
    }
    if (s.status === "active" && s.current_period_end && s.current_period_end <= nowIso) {
      const charges = await deps.store.listSubscriptionCharges(tenant.id, s.id);
      const paidPeriods = new Set(charges.filter((c) => c.status === "paid").map((c) => c.period_index)).size;
      if (paidPeriods >= s.total_periods) {
        const moved = await deps.store.transitionSubscription(tenant.id, s.id, ["active"], "expired", { ended_at: nowIso });
        if (moved) {
          out.expired++;
          if (await revokeEntitlement(deps.store, tenant, moved, "completed")) out.revoked++;
        }
      } else {
        // 應扣未扣（沒收到這期的通知）→ 進寬限期，等藍新重送或下次授權
        const settings = await settingsFor(deps.store, tenant);
        if (await deps.store.transitionSubscription(tenant.id, s.id, ["active"], "past_due", { grace_until: new Date(now.getTime() + (settings.graceDays ?? DEFAULT_GRACE_DAYS) * 86400_000).toISOString() })) out.pastDue++;
      }
      continue;
    }
    if ((s.status === "cancelled" || s.status === "expired") && s.entitlement_state === "granted" && (!s.ended_at || s.ended_at <= nowIso)) {
      if (await revokeEntitlement(deps.store, tenant, s, s.status)) out.revoked++;
    }
  }
  return out;
}
