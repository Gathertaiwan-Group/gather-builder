import type { OrderRow, OrderStatus, PaymentRow, Store, TenantRow } from "../store/types";
import { ORDER_STATUS_LABEL, assertTransition, canTransition, sourcesFor } from "../shop/machine";
import { classifyPchomepayQuery, createPchomepayClient, genGatewayOrderNo, type PchomepayClient, type PchomepayQuery } from "../pay/pchomepay";
import { getMailer } from "../mail";
import { autoIssueOnPaid } from "./invoices";
import { retryHookFailures, runCancelHooks, runPaidHooks } from "./order-hooks";
// 模組副作用註冊（side-effect import：referral 在載入時註冊付款／取消 hook）
import "./referral";
// 第四批：活動報名（付款確認報名、取消後候補遞補）
import "./events";
import "./booking";
import "./courses";
// 第五批：點數（賺點／沖回）
import "./loyalty";
// 第八批：團主分潤（葉節點）
import "./groupbuy-hooks";
import { isTopupOrder, topupReclaimState, topupReversalPreview, topupReversalText } from "./wallet";
import { decryptSecret, encryptSecret } from "../secretbox";
import { PROVIDER_IDS, PROVIDER_LABEL, REFUND_CAPABLE as refundableProviders, isOnlineMethod, type AuthoritativeResult, type PaymentProvider, type ProviderId } from "../pay/types";
import { providerFromAccount } from "../pay/registry";
import { payToken, verifyPayToken } from "../pay/notify-token";
import { CALLBACK_URL_LIMITS, MAX_BASE_URL_FOR_PERIOD, NEWEBPAY_PERIOD_URL_LIMIT, SHORT_CODE_LEN, assertUrlLengths, genShortCode, shortPayUrls, shortSubscriptionUrls } from "../pay/urls";
import { ServiceError, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { mailSafe, orderPageUrl, publishedShopSettings, requireShop, twd, type CheckoutDeps } from "./shop";

type Mailer = CheckoutDeps["sendMail"];

/* ================================================================== 逾期 */

/** 權威回查的依賴（notify 與逾期處理共用） */
export interface PayDeps {
  store: Store;
  sendMail?: Mailer;
  baseUrl: string;
  /** PChomePay（相容舊介面）：依「建單時的環境」取查單 client；環境與目前憑證不符（L1）或沒有憑證回 null */
  queryFor?: (tenantId: string, sandbox: boolean) => Promise<Pick<PchomepayClient, "queryPayment"> | null>;
  /** 第七批：依 provider 與建單環境取 PaymentProvider（測試注入 mock；預設讀 DB 憑證） */
  providerFor?: (tenantId: string, provider: ProviderId, sandbox: boolean) => Promise<PaymentProvider | null>;
}

const ctxPayDeps = (ctx: ServiceContext): PayDeps => ({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl });

/** 回查連續失敗幾次就警示店主 */
export const QUERY_FAILURE_ALERT_AT = 3;

function defaultPayDeps(store: Store): PayDeps {
  return { store, sendMail: getMailer(), baseUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "") };
}

/** 預設：讀 DB 憑證建 provider。🔴 回查環境必須等於建單環境（L1）：付款是在 sandbox 建的就只能用 sandbox 憑證回查（反之亦然） */
export async function defaultProviderFor(store: Store, tenantId: string, provider: ProviderId, sandbox: boolean): Promise<PaymentProvider | null> {
  const acct = await store.getPaymentAccount(tenantId, provider);
  if (!acct) return null;
  if (acct.sandbox !== sandbox) {
    console.error(`[${provider}] 憑證環境（${acct.sandbox ? "sandbox" : "正式"}）與付款建單環境（${sandbox ? "sandbox" : "正式"}）不符，拒絕回查 tenant=${tenantId}`);
    return null;
  }
  return providerFromAccount(acct, tenantId);
}

/** 回查異常警示（同一筆付款只寄一次：alerted_at 條件更新） */
async function alertOwner(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderNo: string, reason: string) {
  if (!(await deps.store.markPaymentAlerted(tenant.id, payment.id))) return;
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system", action: "payment.query_alert", payload: { orderNo, gatewayOrderNo: payment.gateway_order_no, provider: payment.provider, reason } });
  const settings = await publishedShopSettings(deps.store, tenant);
  if (settings.ownerEmail) {
    const label = PROVIDER_LABEL[payment.provider] ?? payment.provider;
    await mailSafe(
      deps,
      settings.ownerEmail,
      `⚠️【${tenant.name}】線上付款狀態無法確認 ${orderNo}`,
      `訂單 ${orderNo}（閘道編號 ${payment.gateway_order_no}）向 ${label} 回查付款狀態時發生問題：${reason}\n系統不會自動取消這張訂單，會持續重試。請到 ${label} 商家後台確認是否已收款。`,
    );
  }
}

type QueryOutcome =
  | { kind: "query_failed" }
  | { kind: "unknown" | "pending" | "failed" | "paid"; q: AuthoritativeResult; legacy?: PchomepayQuery };

/** 對一筆付款做權威回查並分類；回查失敗會累計次數，達門檻警示店主。callbackHint 只給黑貓（實收金額在 APN） */
async function queryAuthoritative(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderNo: string, callbackHint?: Record<string, unknown>): Promise<QueryOutcome> {
  let q: AuthoritativeResult | null = null;
  let legacy: PchomepayQuery | undefined;
  let err = "回查失敗";
  try {
    if (payment.provider === "pchomepay" && deps.queryFor) {
      const client = await deps.queryFor(tenant.id, payment.sandbox);
      if (!client) err = "沒有可用的憑證，或憑證環境與建單時不符";
      const pq = client ? await client.queryPayment(payment.gateway_order_no) : null;
      if (pq) {
        legacy = pq;
        q = { state: classifyPchomepayQuery(pq), amount: pq.amount, statusText: `status=${pq.status ?? "-"} status_code=${pq.status_code ?? "-"}`, raw: pq.raw };
      }
    } else {
      const provider = deps.providerFor ? await deps.providerFor(tenant.id, payment.provider, payment.sandbox) : await defaultProviderFor(deps.store, tenant.id, payment.provider, payment.sandbox);
      if (!provider) err = "沒有可用的憑證，或憑證環境與建單時不符";
      q = provider ? await provider.queryPayment({ gatewayOrderNo: payment.gateway_order_no, amount: payment.amount, tradeNo: payment.gateway_trade_no ?? null }, callbackHint) : null;
    }
  } catch (e) {
    err = `回查例外：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!q) {
    const n = await deps.store.bumpPaymentQueryFailure(tenant.id, payment.id, err);
    console.error(`[${payment.provider}] ${err}（第 ${n} 次）order=${orderNo} gateway=${payment.gateway_order_no}`);
    if (n >= QUERY_FAILURE_ALERT_AT) await alertOwner(deps, tenant, payment, orderNo, `連續 ${n} 次回查失敗（${err}）`);
    return { kind: "query_failed" };
  }
  // 綠界 stage「模擬付款」等：不是真的付款，當成無法辨識（不標記、警示）
  const state = q.simulated && q.state === "paid" ? "unknown" : q.state;
  if (state === "unknown") {
    console.error(`[${payment.provider}] 🔴 無法辨識的查單狀態 ${q.statusText} order=${orderNo}`);
    await deps.store.updatePayment(tenant.id, payment.id, { raw: { query: q.raw } });
    await alertOwner(deps, tenant, payment, orderNo, `無法辨識的付款狀態（${q.statusText}）`);
    return { kind: "unknown", q, legacy };
  }
  if (payment.query_failures) await deps.store.updatePayment(tenant.id, payment.id, { query_failures: 0, last_query_error: null });
  return { kind: state, q, legacy };
}

/**
 * 逾期未付 → 取消並回補庫存（冪等：條件式取消，重複呼叫只會成功一次）。
 * 讀訂單時 lazy 呼叫；另有每日 cron 掃一遍（/api/cron/expire-orders）。
 * 🔴 H2：線上付款訂單取消前，先對所有 pending 付款做權威回查（每一家 provider 都一樣）——
 *   已付 → 走正常付款流程（不取消）；回查失敗或狀態無法辨識 → 這次不取消（下次再試），連續失敗警示店主。
 *   LINE Pay 已授權未 confirm（0110）→ 先以 DB 金額補 confirm；confirm 結果不明 → 不取消。
 */
export async function expireIfDue(store: Store, order: OrderRow, now = Date.now(), deps?: PayDeps): Promise<OrderRow> {
  if (order.status !== "pending_payment" || !order.expires_at || new Date(order.expires_at).getTime() > now) return order;
  if (isOnlineMethod(order.payment_method)) {
    const d = deps ?? defaultPayDeps(store);
    const tenant = await store.getTenantById(order.tenant_id);
    if (!tenant) return order;
    const pending = (await store.listPaymentsForOrder(order.tenant_id, order.id)).filter((p) => p.status === "pending" || (p.status === "failed" && p.provider !== "pchomepay"));
    for (const p of pending) {
      const r = await queryAuthoritative(d, tenant, p, order.order_no);
      if (p.status === "failed") {
        // 第七批審查 L10：之前回查失敗（刷卡被拒）的付款，客人可能在同一付款頁重試成功而通知遺失 → 已付才重新打開
        if (r.kind !== "paid") continue;
        if (!(await store.transitionPayment(order.tenant_id, p.id, "failed", "pending", {}))) continue;
        p.status = "pending";
      }
      if (r.kind === "query_failed" || r.kind === "unknown") return order; // 不確定就不取消
      if (r.kind === "paid") {
        const out = await settlePaid(d, tenant, p, order, r.q);
        if (out === "missing_amount") await alertOwner(d, tenant, p, order.order_no, `${PROVIDER_LABEL[p.provider]} 回查為已付款，但缺少可比對的實收金額（${p.provider === "blackcat" ? "黑貓 PAY 的實收金額只在 APN 通知裡" : "回查未回金額"}），系統不會自動取消，請到商家後台確認`);
        return (await store.getOrderById(order.tenant_id, order.id)) ?? order;
      }
      if (r.kind === "pending" && r.q.needsConfirm && p.provider === "linepay") {
        const c = await confirmLinepayPayment(d, tenant, p, order);
        if (c !== "failed") return (await store.getOrderById(order.tenant_id, order.id)) ?? order;
        continue;
      }
      if (r.kind === "failed") await store.transitionPayment(order.tenant_id, p.id, "pending", "failed", { raw: { query: r.q.raw } });
      // pending（客人沒完成付款）＝可以取消
    }
  }
  const r = await store.cancelOrder(order.tenant_id, order.id, ["pending_payment"], "expired");
  if (r.transitioned) {
    await store.insertAudit({ tenant_id: order.tenant_id, actor: "system", action: "order.expire", payload: { orderNo: order.order_no, stockReleased: r.stockReleased } });
    const t = await store.getTenantById(order.tenant_id);
    const after = await store.getOrderById(order.tenant_id, order.id);
    if (t && after) await runCancelHooks(store, t, after, deps ? { sendMail: deps.sendMail, baseUrl: deps.baseUrl } : undefined);
  }
  return (await store.getOrderById(order.tenant_id, order.id)) ?? order;
}

export async function expireDueOrders(store: Store, limit = 200, deps?: PayDeps): Promise<{ scanned: number; expired: number }> {
  const due = await store.listExpiredPendingOrders(new Date().toISOString(), limit);
  let expired = 0;
  for (const d of due) {
    const o = await store.getOrderById(d.tenant_id, d.id);
    if (!o) continue;
    const after = await expireIfDue(store, o, Date.now(), deps);
    if (after.status === "cancelled" && o.status === "pending_payment") expired++;
  }
  return { scanned: due.length, expired };
}

/** 下單前：先釋放這些商品已逾期的保留（線上付款單一樣先回查） */
export async function releaseExpiredHolds(deps: PayDeps, tenantId: string, productIds: string[]) {
  const due = await deps.store.listExpiredPendingOrdersForProducts(tenantId, productIds, new Date().toISOString(), 20);
  for (const o of due) await expireIfDue(deps.store, o, Date.now(), deps);
  return due.length;
}

/* ================================================================== 讀取 */

function orderSummary(o: OrderRow) {
  return {
    id: o.id,
    orderNo: o.order_no,
    status: o.status,
    statusLabel: ORDER_STATUS_LABEL[o.status],
    paymentMethod: o.payment_method,
    /** true = PChomePay 測試環境付款（沒有實際收款，不能出貨） */
    paymentSandbox: o.payment_sandbox ?? false,
    total: o.total,
    memberId: o.member_id,
    contactName: o.contact.name,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    expiresAt: o.status === "pending_payment" ? o.expires_at : null,
  };
}

async function findOrder(ctx: ServiceContext, tenant: TenantRow, ref: { orderId?: string; orderNo?: string }) {
  const o = ref.orderId ? await ctx.store.getOrderById(tenant.id, ref.orderId) : ref.orderNo ? await ctx.store.getOrderByNo(tenant.id, ref.orderNo) : null;
  if (!o) throw new ServiceError("not_found", "找不到訂單（請給 orderId 或 orderNo）");
  // M2：讀取時補做這張訂單失敗過的付款／取消副作用（冪等）
  await retryOrderHooks(ctxPayDeps(ctx), { orderId: o.id }).catch((e) => console.error("[hooks] lazy retry", e));
  return expireIfDue(ctx.store, o, Date.now(), ctxPayDeps(ctx));
}

/**
 * M2：補做失敗的 hook（cron 跑全部、讀訂單時只跑該訂單）；連續失敗 HOOK_ALERT_AT 次寄店主警示一次。
 */
export async function retryOrderHooks(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, opts: { orderId?: string; limit?: number; countAttempts?: boolean } = {}) {
  return retryHookFailures(
    {
      ...deps,
      alert: async (tenant, order, hook, event, attempts, error) => {
        const settings = await publishedShopSettings(deps.store, tenant);
        if (!settings.ownerEmail) return;
        await mailSafe(
          deps,
          settings.ownerEmail,
          `⚠️【${tenant.name}】訂單 ${order.order_no} 的${event === "paid" ? "付款後" : "取消後"}處理失敗（${hook}）`,
          `訂單 ${order.order_no} 的「${hook}」${event === "paid" ? "付款成功後的處理（例如確認報名／預約、開通課程）" : "取消後的處理"}已連續失敗 ${attempts} 次，系統會持續每日重試。\n最後錯誤：${error}\n請到後台確認這張訂單的報名／預約／課程狀態，必要時手動處理。`,
        );
      },
    },
    opts,
  );
}

/**
 * L2：系統取消（金流建單失敗、取消場次、取消預約…）一律走這裡：條件式取消（同交易回補庫存／優惠券／名額）＋取消 hooks。
 * 回傳是否真的轉換。
 */
export async function cancelOrderWithHooks(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, orderId: string, from: OrderStatus[], reason: string) {
  const r = await deps.store.cancelOrder(tenant.id, orderId, from, reason);
  if (!r.transitioned) return r;
  const after = await deps.store.getOrderById(tenant.id, orderId);
  if (after) {
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system", action: "order.cancel", payload: { orderNo: after.order_no, reason, stockReleased: r.stockReleased } });
    await runCancelHooks(deps.store, tenant, after, { sendMail: deps.sendMail, baseUrl: deps.baseUrl });
  }
  return r;
}

export async function listOrders(ctx: ServiceContext, input: { site?: string | null; status?: OrderStatus; limit?: number; offset?: number }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const lim = Math.max(1, Math.min(100, input.limit ?? 20));
  let r = await ctx.store.listOrders(tenant.id, { status: input.status, limit: lim, offset: Math.max(0, input.offset ?? 0) });
  // lazy 逾期處理
  const due = r.rows.filter((o) => o.status === "pending_payment" && o.expires_at && new Date(o.expires_at).getTime() <= Date.now());
  if (due.length) {
    for (const o of due) await expireIfDue(ctx.store, o, Date.now(), ctxPayDeps(ctx));
    r = await ctx.store.listOrders(tenant.id, { status: input.status, limit: lim, offset: Math.max(0, input.offset ?? 0) });
  }
  return { total: r.total, orders: r.rows.map(orderSummary) };
}

export async function getOrder(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  const [items, payments] = await Promise.all([ctx.store.listOrderItems(tenant.id, o.id), ctx.store.listPaymentsForOrder(tenant.id, o.id)]);
  // 審查 M2：儲值訂單取消前的試算（已用掉／可收回／不足）
  const topupReversal = o.status !== "cancelled" ? await topupReversalPreview(ctx.store, tenant, o) : null;
  return {
    ...orderSummary(o),
    contact: o.contact,
    shipping: o.shipping,
    note: o.note,
    items: items.map((i) => ({ productId: i.product_id, variantId: i.variant_id, name: i.name, variantLabel: i.variant_label, sku: i.sku, unitPrice: i.unit_price, qty: i.qty, lineTotal: i.line_total })),
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    fulfilledAt: o.fulfilled_at,
    cancelledAt: o.cancelled_at,
    cancelReason: o.cancel_reason,
    shippingMethod: o.shipping_method,
    shippingTracking: o.shipping_tracking,
    invoiceStatus: o.invoice_status,
    invoiceRequest: o.invoice_request,
    discountTotal: o.discount_total ?? 0,
    couponCode: o.coupon_code,
    tierDiscount: o.tier_discount ?? 0,
    pointsRedeemed: o.points_redeemed ?? 0,
    pointsDiscount: o.points_discount ?? 0,
    walletPaid: o.wallet_paid ?? 0,
    shippingChoice: o.shipping_choice,
    // 付款紀錄只給狀態，不給閘道原始回應
    payments: payments.map((p) => ({ provider: p.provider, gatewayOrderNo: p.gateway_order_no, amount: p.amount, status: p.status, sandbox: p.sandbox, paidAt: p.paid_at, createdAt: p.created_at })),
    allowedNext: (["paid", "fulfilled", "cancelled"] as OrderStatus[]).filter((s) => canTransition(o.status, s)),
    topupReversal: topupReversal ? { ...topupReversal, note: topupReversalText(topupReversal) } : null,
    refunds: (await ctx.store.listRefundsForOrder(tenant.id, o.id)).map((r) => ({ id: r.id, provider: r.provider, amount: r.amount, status: r.status, error: r.error, createdAt: r.created_at })),
    refundedAt: o.refunded_at ?? null,
    /** 第七批審查 H4／M1：退款前先讓使用者看到會撤回什麼（儲值訂單另附已用／可收回／不足） */
    refundPreview: { effects: refundEffectsText(o), topupBlocked: !!topupReversal && topupReversal.used > 0 },
  };
}

/* ================================================================== 狀態轉換（後台＋MCP） */

function requireConfirm(confirm: boolean | undefined, what: string) {
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

function transitionGuard(o: OrderRow, to: OrderStatus) {
  try {
    assertTransition(o.status, to);
  } catch (e) {
    throw new ServiceError("conflict", `${e instanceof Error ? e.message : String(e)}（訂單 ${o.order_no} 目前為「${ORDER_STATUS_LABEL[o.status]}」）`);
  }
}

/** 付款成功的副作用（只在「真正轉換成功」那一次呼叫）：通知客人與店主 */
export async function onOrderPaid(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, order: OrderRow, via: string, opts: { sandbox?: boolean } = {}) {
  await onOrderPaidMails(deps, tenant, order, via, opts);
  if (opts.sandbox) return;
  // 模組副作用（各自冪等、失敗不影響付款）：自動開發票、推薦回饋／分潤
  await autoIssueOnPaid(deps.store, tenant, order);
  await runPaidHooks(deps, tenant, order);
}

async function onOrderPaidMails(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, order: OrderRow, via: string, opts: { sandbox?: boolean }) {
  const settings = await publishedShopSettings(deps.store, tenant);
  const url = orderPageUrl(deps.baseUrl, tenant, order.order_no);
  if (opts.sandbox) {
    // H1：測試環境付款不是真的收到錢——客人與店主都要清楚看到「不會出貨」
    await mailSafe(deps, order.contact.email, `【${tenant.name}】［測試付款］${order.order_no}`, `${order.contact.name} 你好，\n\n訂單 ${order.order_no} 是在金流「測試環境」完成付款，並沒有實際扣款，這筆訂單不會出貨。\n\n訂單狀態：${url}`);
    if (settings.ownerEmail) {
      await mailSafe(deps, settings.ownerEmail, `［測試付款・請勿出貨］【${tenant.name}】${order.order_no}`, `這筆訂單是用 PChomePay 測試環境（sandbox）憑證付款，沒有收到真的錢，系統會拒絕出貨。\n如果網站已正式營業，請到平台後台換成正式憑證。`);
    }
    return;
  }
  await mailSafe(deps, order.contact.email, `【${tenant.name}】付款成功 ${order.order_no}`, `${order.contact.name} 你好，\n\n訂單 ${order.order_no} 已確認付款 ${twd(order.total)}，我們會盡快出貨。\n\n訂單狀態：${url}（會員可在會員中心查看）`);
  if (settings.ownerEmail) {
    await mailSafe(deps, settings.ownerEmail, `【${tenant.name}】訂單已付款 ${order.order_no}（${twd(order.total)}）`, `付款方式：${via}\n訂購人：${order.contact.name} ${order.contact.email}\n請安排出貨。`);
  }
}

export async function markOrderPaid(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean }) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  if (o.payment_method !== "offline") {
    throw new ServiceError("invalid", `訂單 ${o.order_no} 是線上付款（PChomePay），付款狀態由金流通知回查後自動更新，不能手動標記。`);
  }
  transitionGuard(o, "paid");
  requireConfirm(input.confirm, `標記訂單 ${o.order_no} 已收款（${twd(o.total)}）會通知客人並進入出貨流程`);
  const moved = await ctx.store.transitionOrder(tenant.id, o.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
  if (!moved) throw new ServiceError("conflict", `訂單 ${o.order_no} 狀態已被其他操作改變，請重新讀取`);
  await audit(ctx, tenant.id, "order.mark_paid", { orderNo: o.order_no, total: o.total });
  await onOrderPaid({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, moved, "線下匯款（店主標記）");
  return orderSummary(moved);
}

export async function fulfillOrder(
  ctx: ServiceContext,
  input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean; shippingMethod?: string; trackingNumber?: string },
) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  transitionGuard(o, "fulfilled");
  // H1：測試環境（sandbox）付款的訂單沒有真的收到錢，絕不能出貨
  const sandboxPaid = o.payment_sandbox || (await ctx.store.listPaymentsForOrder(tenant.id, o.id)).some((p) => p.sandbox && p.status === "paid");
  if (sandboxPaid) throw new ServiceError("invalid", `訂單 ${o.order_no} 是 PChomePay 測試環境（sandbox）付款，沒有實際收款，不能出貨。請取消這張訂單。`);
  // 第八批審查 M-1：儲值訂單不是實體商品、不需出貨；標成已出貨會讓退款走「先退錢」路徑（違反先收回儲值金再退款）
  if (isTopupOrder(o)) throw new ServiceError("invalid", `訂單 ${o.order_no} 是儲值訂單，不需要出貨（付款後儲值金已自動入帳）`);
  // shipping 模組：已建立綠界物流單的訂單，出貨狀態以物流通知為準
  const active = await ctx.store.getActiveShipmentByOrder(tenant.id, o.id);
  if (active?.provider === "ecpay") throw new ServiceError("conflict", `訂單 ${o.order_no} 已建立綠界物流單（${active.logistics_id ?? "建立中"}），出貨狀態以物流通知為準，不能手動標記`);
  requireConfirm(input.confirm, `把訂單 ${o.order_no} 標記為已出貨會通知客人`);
  const moved = await ctx.store.transitionOrder(tenant.id, o.id, "paid", "fulfilled", {
    fulfilled_at: new Date().toISOString(),
    shipping_method: input.shippingMethod?.trim().slice(0, 60) || null,
    shipping_tracking: input.trackingNumber?.trim().slice(0, 100) || null,
  });
  if (!moved) throw new ServiceError("conflict", `訂單 ${o.order_no} 狀態已被其他操作改變，請重新讀取`);
  await audit(ctx, tenant.id, "order.fulfill", { orderNo: o.order_no });
  await mailSafe(
    { sendMail: ctx.sendMail },
    o.contact.email,
    `【${tenant.name}】訂單已出貨 ${o.order_no}`,
    `${o.contact.name} 你好，訂單 ${o.order_no} 已出貨。${moved.shipping_tracking ? `\n物流單號：${moved.shipping_tracking}` : ""}`,
  );
  return orderSummary(moved);
}

export async function cancelOrder(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean; reason?: string }) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  transitionGuard(o, "cancelled");
  const refundNote =
    o.status === "paid"
      ? o.payment_method === "pchomepay"
        ? "此訂單已透過 PChomePay 付款：取消不會自動退款，請到 PChomePay 商家後台人工退款。"
        : isOnlineMethod(o.payment_method)
          ? refundableProviders.has(o.payment_method)
            ? `此訂單已透過 ${PROVIDER_LABEL[o.payment_method]} 付款：取消不會自動退款。要退款請改用 refund_order（confirm: true，退款成功會自動取消訂單），或到 ${PROVIDER_LABEL[o.payment_method]} 商家後台人工退款。`
            : `此訂單已透過 ${PROVIDER_LABEL[o.payment_method]} 付款：取消不會自動退款，請到 ${PROVIDER_LABEL[o.payment_method]} 商家後台人工退款。`
        : o.payment_method === "credit"
          ? "此訂單全額以點數／儲值金支付：取消會自動退回點數與儲值金，不需另外退款。"
          : "此訂單已收款（線下匯款）：取消不會自動退款，請自行退款給客人。"
      : null;
  // 審查 M2：已入帳的儲值訂單 → 確認前先說清楚可收回／不足多少
  const topup = await topupReversalPreview(ctx.store, tenant, o);
  requireConfirm(input.confirm, `取消訂單 ${o.order_no} 會回補庫存且無法復原${refundNote ? `。注意：${refundNote}` : ""}${topup ? `。${topupReversalText(topup)}` : ""}`);
  const r = await ctx.store.cancelOrder(tenant.id, o.id, sourcesFor("cancelled").filter((s) => s === o.status), input.reason?.trim().slice(0, 200) || "cancelled_by_shop");
  if (!r.transitioned) throw new ServiceError("conflict", `訂單 ${o.order_no} 狀態已被其他操作改變，請重新讀取`);
  await audit(ctx, tenant.id, "order.cancel", { orderNo: o.order_no, from: o.status, stockReleased: r.stockReleased });
  const after = (await ctx.store.getOrderById(tenant.id, o.id))!;
  await runCancelHooks(ctx.store, tenant, after, { sendMail: ctx.sendMail, baseUrl: ctx.baseUrl });
  // 已開立發票的訂單取消：提示作廢（同期）或折讓（跨期）
  // 實際收回結果（以帳本為準；什麼都收不回時沒有 reverse 分錄）
  const topupActual = topup
    ? await (async () => {
        const rev = await ctx.store.getCreditByRef("wallet", tenant.id, `order:${o.id}:topup_reverse`);
        const reclaimed = rev ? Math.abs(rev.amount) : 0;
        return { credited: topup.credited, used: topup.credited - reclaimed, reclaimable: reclaimed, shortfall: topup.credited - reclaimed };
      })()
    : null;
  const inv = await ctx.store.getInvoiceByOrder(tenant.id, o.id);
  const invoiceNote = inv?.status === "issued" ? `此訂單已開立發票 ${inv.invoice_no}：請用 void_invoice（confirm: true）處理——同一期會作廢，跨期會改開折讓單。` : null;
  return {
    ...orderSummary(after),
    stockReleased: r.stockReleased,
    refundRequired: !!refundNote && o.payment_method !== "credit",
    invoiceActionRequired: !!invoiceNote,
    /** 儲值訂單：入帳／收回／不足（不足的部分沒有收回，退款時請扣除） */
    topupReversal: topupActual,
    note: [refundNote ?? "訂單已取消，庫存已回補。", topupActual ? `已收回儲值金 ${twd(topupActual.reclaimable)}${topupActual.shortfall ? `，不足 ${twd(topupActual.shortfall)} 無法收回（退款時請扣除）` : ""}。` : null, invoiceNote].filter(Boolean).join(" "),
  };
}

/* ================================================================== 金流憑證 */

function maskAppId(id: string) {
  return id.length <= 4 ? "****" : `${"*".repeat(Math.min(8, id.length - 4))}${id.slice(-4)}`;
}

/** 🔴 只有平台後台（admin actor）能設定憑證；MCP 沒有任何設定或讀出 secret 的工具 */
function requireAdminActor(ctx: ServiceContext) {
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "金流憑證只能從平台後台表單輸入（不經過 agent 對話）");
}

export async function savePaymentAccount(ctx: ServiceContext, input: { site: string; appId: string; secret: string; sandbox: boolean }) {
  requireAdminActor(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const appId = input.appId.trim();
  const secret = input.secret.trim();
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(appId)) throw new ServiceError("invalid", "APP ID 格式不正確");
  if (secret.length < 8 || secret.length > 200) throw new ServiceError("invalid", "SECRET 長度不正確");
  await ctx.store.upsertPaymentAccount({ tenant_id: tenant.id, provider: "pchomepay", sandbox: input.sandbox, app_id: appId, secret_enc: encryptSecret(secret, tenant.id) });
  await syncShopModuleStatus(ctx.store, tenant.id);
  await audit(ctx, tenant.id, "payment_account.save", { provider: "pchomepay", sandbox: input.sandbox, appId: maskAppId(appId) });
  return { saved: true, status: "unverified" as const, note: "憑證已加密儲存，請按「驗證」確認可用。" };
}

/** 依 DB 憑證建 client（解密只在 server 記憶體中）；沒有憑證回 null */
export async function pchomepayClientFor(store: Store, tenantId: string, opts: { requireVerified: boolean } = { requireVerified: true }): Promise<{ client: PchomepayClient; sandbox: boolean } | null> {
  const acct = await store.getPaymentAccount(tenantId, "pchomepay");
  if (!acct || (opts.requireVerified && acct.status !== "verified")) return null;
  const secret = decryptSecret(acct.secret_enc, tenantId);
  return { client: createPchomepayClient({ cacheKey: tenantId, appId: acct.app_id, secret, sandbox: acct.sandbox }), sandbox: acct.sandbox };
}

export async function verifyPaymentAccount(ctx: ServiceContext, input: { site: string }, clientFactory = pchomepayClientFor) {
  requireAdminActor(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const c = await clientFactory(ctx.store, tenant.id, { requireVerified: false });
  if (!c) throw new ServiceError("invalid", "尚未輸入 PChomePay 憑證");
  const r = await c.client.verify();
  if (r.ok) {
    await ctx.store.markPaymentAccount(tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  } else {
    await ctx.store.markPaymentAccount(tenant.id, "pchomepay", { status: "unverified", verified_at: null, last_error: r.message.slice(0, 300) });
  }
  await syncShopModuleStatus(ctx.store, tenant.id);
  await audit(ctx, tenant.id, "payment_account.verify", { ok: r.ok, sandbox: c.sandbox });
  if (!r.ok) throw new ServiceError("invalid", `驗證失敗：${r.message}`);
  return { verified: true, sandbox: c.sandbox };
}

export async function getPaymentSetupStatus(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const [acct, states, settings, all] = await Promise.all([ctx.store.getPaymentAccount(tenant.id, "pchomepay"), moduleStates(ctx, tenant.id), publishedShopSettings(ctx.store, tenant), ctx.store.listPaymentAccounts(tenant.id)]);
  return {
    shopModuleStatus: states.get("shop")?.status ?? "disabled",
    pchomepay: acct
      ? { configured: true, status: acct.status, sandbox: acct.sandbox, appId: maskAppId(acct.app_id), verifiedAt: acct.verified_at, lastError: acct.last_error }
      : { configured: false, status: "not_configured" },
    /** 第七批：每一家的狀態（只有狀態與遮罩後的商店代號；MCP 讀不到任何金鑰） */
    providers: PROVIDER_IDS.map((id) => {
      const a = all.find((x) => x.provider === id);
      return a
        ? { provider: id, label: PROVIDER_LABEL[id], configured: true, status: a.status, sandbox: a.sandbox, merchantId: maskAppId(a.app_id), verifiedAt: a.verified_at, lastError: a.last_error, autoRefund: refundableProviders.has(id) }
        : { provider: id, label: PROVIDER_LABEL[id], configured: false, status: "not_configured" as const, autoRefund: refundableProviders.has(id) };
    }),
    offlineTransfer: { enabled: !!settings.offlineTransfer?.enabled },
    note: `憑證只能由平台擁有者在後台「金流設定」輸入並驗證；MCP 無法設定或讀出金鑰。${acct?.sandbox ? "目前是測試環境（sandbox）憑證：只有帶預覽簽章的結帳能用線上付款，已發布網站的訪客看不到線上付款；正式營業前請換成正式憑證。" : ""}`,
  };
}

/** shop 模組狀態：沒有任何已驗證的金流憑證 → pending_setup（仍可只用線下匯款） */
export async function syncShopModuleStatus(store: Store, tenantId: string) {
  const row = (await store.listTenantModules(tenantId)).find((m) => m.module_id === "shop");
  if (!row || row.status === "disabled") return;
  const want = (await store.listPaymentAccounts(tenantId)).some((a) => a.status === "verified") ? "enabled" : "pending_setup";
  if (row.status !== want) await store.upsertTenantModule({ ...row, status: want });
}

/* ================================================================== PChomePay 付款 */

/** 建 builder_payments（gateway_order_no 唯一）→ 呼叫 PChomePay 建單 → 回 payment_url */
export async function startPchomepayPayment(
  deps: { store: Store; baseUrl: string; clientFactory?: typeof pchomepayClientFor },
  input: { tenant: TenantRow; order: OrderRow; accessKey: string },
): Promise<{ paymentUrl: string; gatewayOrderNo: string }> {
  const { tenant, order } = input;
  if (order.status !== "pending_payment" || order.payment_method !== "pchomepay") throw new ServiceError("invalid", "這筆訂單不需要線上付款");
  const c = await (deps.clientFactory ?? pchomepayClientFor)(deps.store, tenant.id);
  if (!c) throw new ServiceError("invalid", "此商店目前無法使用線上付款");
  const gatewayOrderNo = genGatewayOrderNo();
  const payment = await deps.store.insertPayment({ tenant_id: tenant.id, order_id: order.id, provider: "pchomepay", gateway_order_no: gatewayOrderNo, amount: order.total, sandbox: c.sandbox });
  const base = deps.baseUrl.replace(/\/$/, "");
  const r = await c.client.createPayment({
    orderNo: gatewayOrderNo,
    amount: order.total,
    itemName: `${tenant.name} 訂單 ${order.order_no}`,
    itemUrl: `${base}/s/${tenant.slug}/shop`,
    returnUrl: orderPageUrl(base, tenant, order.order_no, input.accessKey),
    notifyUrl: `${base}/api/pay/pchomepay/notify/${tenant.id}`,
    buyerEmail: order.contact.email,
    holdHours: order.expires_at ? (new Date(order.expires_at).getTime() - Date.now()) / 3600_000 : 0,
  });
  if (!r) {
    await deps.store.updatePayment(tenant.id, payment.id, { status: "failed" });
    throw new ServiceError("invalid", "金流建單失敗，請稍後再試或改用其他付款方式");
  }
  await deps.store.updatePayment(tenant.id, payment.id, { payment_url: r.paymentUrl });
  return { paymentUrl: r.paymentUrl, gatewayOrderNo };
}

export type NotifyResult = { status: 200 | 500; body: "success" | "retry"; outcome: string };

/**
 * 權威回查判定「已付」之後的處理（notify 與逾期前回查共用）。回傳 outcome。
 * - 金額 round 後必須等於付款紀錄與訂單總額，不符不標記。
 * - 條件式轉換 pending_payment → paid：只有真正轉換成功的那一次才跑副作用（冪等）。
 * - 訂單已取消／逾期卻收到付款 → 不改訂單、付款標 paid_after_cancel、寄店主警示（只寄一次）。
 * - H1：sandbox 付款成功的訂單標記 payment_sandbox（不是真的收到錢，不能出貨）。
 */
async function settlePaid(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderIn: OrderRow, q: Pick<AuthoritativeResult, "amount" | "raw" | "tradeNo">): Promise<"paid" | "missing_amount" | "amount_mismatch" | "paid_after_cancel" | "already_processed" | "order_missing"> {
  const gw = payment.gateway_order_no;
  const label = PROVIDER_LABEL[payment.provider] ?? payment.provider;
  if (q.amount == null || !Number.isFinite(q.amount)) {
    console.error(`[${payment.provider}] 權威已付但缺 amount，待重試 order=${gw}`);
    return "missing_amount";
  }
  let order = (await deps.store.getOrderById(tenant.id, orderIn.id)) ?? null;
  if (!order) return "order_missing";
  const raw = { query: q.raw };
  const expected = Math.round(payment.amount);
  if (Math.round(q.amount) !== expected || Math.round(order.total) !== expected) {
    console.error(`[${payment.provider}] 金額不符，不標記付款！order=${order.order_no} gateway=${gw} 期望=${expected} 權威=${q.amount}`);
    await deps.store.updatePayment(tenant.id, payment.id, { raw });
    // 第七批審查 M2：金額不符＝錢可能扣了但訂單不會轉已付 → 警示店主（同一筆只寄一次）
    await alertOwner(deps, tenant, payment, order.order_no, `付款金額不符（訂單 ${expected}、${label} 回查 ${q.amount}），系統沒有標記已付款，請到商家後台確認並處理`);
    return "amount_mismatch";
  }
  const paidAt = new Date().toISOString();
  if (order.status === "pending_payment") {
    // M3：sandbox 付款在同一交易釋放報名／預約保留（測試付款不佔名額）
    const moved = payment.sandbox ? await deps.store.markPaidSandbox(tenant.id, order.id, paidAt) : await deps.store.transitionOrder(tenant.id, order.id, "pending_payment", "paid", { paid_at: paidAt });
    if (moved) {
      await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid", { raw, paid_at: paidAt });
      if (q.tradeNo && !payment.gateway_trade_no) await deps.store.updatePayment(tenant.id, payment.id, { gateway_trade_no: q.tradeNo });
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: payment.provider, action: "order.paid", payload: { orderNo: moved.order_no, gatewayOrderNo: gw, sandbox: payment.sandbox } });
      await onOrderPaid(deps, tenant, moved, `${payment.provider === "pchomepay" ? "PChomePay" : label}${payment.sandbox ? "（測試環境）" : ""}`, { sandbox: payment.sandbox });
      // sandbox：保留已釋放 → 跑取消側的 hook（候補遞補等；各 hook 冪等，未開通的東西不會被動到）
      if (payment.sandbox) await runCancelHooks(deps.store, tenant, moved, { sendMail: deps.sendMail, baseUrl: deps.baseUrl });
      return "paid";
    }
    order = (await deps.store.getOrderById(tenant.id, order.id)) ?? order;
  }
  if (order.status === "cancelled") {
    const first = await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid_after_cancel", { raw, paid_at: paidAt });
    console.error(`[${payment.provider}] 🔴 已取消的訂單收到付款，需人工退款 order=${order.order_no} gateway=${gw} amount=${q.amount} first=${first}`);
    if (first) {
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: payment.provider, action: "order.paid_after_cancel", payload: { orderNo: order.order_no, gatewayOrderNo: gw, amount: q.amount, sandbox: payment.sandbox } });
      const settings = await publishedShopSettings(deps.store, tenant);
      if (settings.ownerEmail) {
        await mailSafe(
          deps,
          settings.ownerEmail,
          `🔴【${tenant.name}】已取消的訂單收到付款，請人工退款 ${order.order_no}${payment.sandbox ? "（測試環境）" : ""}`,
          `訂單 ${order.order_no}（${order.cancel_reason === "expired" ? "逾期自動取消" : "已取消"}）收到 ${payment.provider === "pchomepay" ? "PChomePay" : label} 付款 ${twd(Math.round(q.amount))}。\n閘道訂單編號：${gw}\n系統沒有改變訂單狀態，請${refundableProviders.has(payment.provider) ? "在後台用「退款」（refund_order）處理，或" : ""}到 ${payment.provider === "pchomepay" ? "PChomePay" : label} 商家後台退款，或與客人（${order.contact.name} ${order.contact.email}）聯繫。`,
        );
      }
    }
    return "paid_after_cancel";
  }
  // 已是 paid／fulfilled（重複 notify 或已手動處理）：只補記付款紀錄，不重跑寄信
  const firstRecord = await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid", { raw, paid_at: paidAt });
  // 第七批審查 M3：訂單已轉 paid、但付款紀錄是這次才補記 → 上一次可能在跑副作用前中斷：補跑模組 hooks 與自動發票（兩者都冪等；不重寄信）
  if (firstRecord && order.status === "paid" && !order.payment_sandbox && !payment.sandbox) {
    await autoIssueOnPaid(deps.store, tenant, order);
    await runPaidHooks(deps, tenant, order);
  }
  return "already_processed";
}

/**
 * PChomePay notify（天生公開、沒有簽章）。安全規則：
 * 1. 絕不信 payload：只取 order_id 當查詢鍵，一律 GET /v1/payment/{order_id} 回查權威狀態
 *    （用該租戶自己的憑證，且憑證環境必須與建單時相同——L1）。
 * 2. 權威欄位是 `status`（S／F／P，見 lib/pay/pchomepay.ts 的依據）；無法辨識的狀態 → 記 log、警示店主、回 500 讓對方重試（H3）。
 * 3. 回查失敗回 500（讓對方重試），連續失敗警示店主；其餘處理完一律回純文字 success。
 * 4. 已付的處理見 settlePaid（金額比對、條件式轉換、取消後收款警示、sandbox 標記）。
 */
export async function handlePchomepayNotify(deps: PayDeps, input: { tenantId: string; rawBody: string }): Promise<NotifyResult> {
  const ok = (outcome: string): NotifyResult => ({ status: 200, body: "success", outcome });
  const retry = (outcome: string): NotifyResult => ({ status: 500, body: "retry", outcome });

  const sp = new URLSearchParams(input.rawBody);
  const notifyType = (sp.get("notify_type") ?? "").trim();
  let orderId = "";
  try {
    const msg = JSON.parse(sp.get("notify_message") ?? "") as Record<string, unknown>;
    orderId = String(msg?.order_id ?? "").trim();
  } catch {
    /* 下方處理 */
  }
  if (!orderId || !/^[A-Za-z0-9]{1,40}$/.test(orderId)) {
    console.error(`[pchomepay/notify] 缺 order_id，略過 tenant=${input.tenantId} type=${notifyType}`);
    return ok("missing_order_id");
  }
  const payment = await deps.store.getPaymentByGatewayNo(orderId);
  if (!payment || payment.tenant_id !== input.tenantId) {
    console.error(`[pchomepay/notify] 找不到付款紀錄或租戶不符 tenant=${input.tenantId} order=${orderId}`);
    return ok("unknown_payment");
  }
  const tenant = await deps.store.getTenantById(payment.tenant_id);
  if (!tenant) return ok("unknown_tenant");
  const order = await deps.store.getOrderById(tenant.id, payment.order_id);
  if (!order) return ok("order_missing");

  const r = await queryAuthoritative(deps, tenant, payment, order.order_no);
  if (r.kind === "query_failed") return retry("query_failed");
  const lq = r.legacy ?? { status: r.q.raw.status != null ? String(r.q.raw.status) : undefined, status_code: r.q.raw.status_code != null ? String(r.q.raw.status_code) : undefined };
  if (r.kind === "unknown") return retry(`unknown_status:${lq.status ?? "-"}/${lq.status_code ?? "-"}`);
  if (r.kind === "pending") {
    await deps.store.updatePayment(tenant.id, payment.id, { raw: { notifyType, query: r.q.raw } });
    return ok(`not_paid:${lq.status ?? lq.status_code ?? "?"}`);
  }
  if (r.kind === "failed") {
    await deps.store.transitionPayment(tenant.id, payment.id, "pending", "failed", { raw: { notifyType, query: r.q.raw } });
    return ok(`failed:${lq.status_code ?? lq.status ?? "F"}`);
  }
  const outcome = await settlePaid(deps, tenant, payment, order, r.q);
  if (outcome === "missing_amount") return retry("missing_amount");
  return ok(outcome);
}

export type { PaymentRow };

/* ================================================================== 第七批：多家金流 provider（藍新、綠界、LINE Pay、黑貓、PAYUNi） */

/** 每家 provider 後台表單要輸入的欄位（app_id＝第一欄；其餘加密存 secret_enc） */
export const PROVIDER_FIELDS: Record<Exclude<ProviderId, "pchomepay">, { idLabel: string; idPattern: RegExp; secrets: { key: string; label: string; required: boolean; pattern?: RegExp }[] }> = {
  newebpay: {
    idLabel: "商店代號 MerchantID",
    idPattern: /^[A-Za-z0-9]{4,20}$/,
    secrets: [
      { key: "hashKey", label: "HashKey（32 字）", required: true, pattern: /^[A-Za-z0-9]{32}$/ },
      { key: "hashIv", label: "HashIV（16 字）", required: true, pattern: /^[A-Za-z0-9]{16}$/ },
    ],
  },
  ecpay: {
    idLabel: "特店編號 MerchantID",
    idPattern: /^\d{5,10}$/,
    secrets: [
      { key: "hashKey", label: "HashKey", required: true, pattern: /^[A-Za-z0-9]{8,40}$/ },
      { key: "hashIv", label: "HashIV", required: true, pattern: /^[A-Za-z0-9]{8,40}$/ },
    ],
  },
  payuni: {
    idLabel: "商店代號 MerID",
    idPattern: /^[A-Za-z0-9]{3,30}$/,
    secrets: [
      { key: "hashKey", label: "Hash Key（32 字）", required: true, pattern: /^[A-Za-z0-9]{32}$/ },
      { key: "hashIv", label: "Hash IV（16 字）", required: true, pattern: /^[A-Za-z0-9]{16}$/ },
    ],
  },
  linepay: {
    idLabel: "Channel ID",
    idPattern: /^\d{6,20}$/,
    secrets: [{ key: "channelSecret", label: "Channel Secret Key", required: true, pattern: /^[A-Za-z0-9]{16,64}$/ }],
  },
  blackcat: {
    idLabel: "CUST_ID（契客代號）",
    idPattern: /^[A-Za-z0-9]{4,30}$/,
    secrets: [
      { key: "apiPassword", label: "API 密碼", required: true },
      { key: "refundPassword", label: "取消交易＆退刷密碼（選填；沒填就不提供自動退款）", required: false },
      { key: "acquirerType", label: "收單行（esun／chinatrust／payuni，預設 payuni）", required: false, pattern: /^(esun|chinatrust|payuni)$/ },
    ],
  },
};

function maskId(id: string) {
  return id.length <= 4 ? "****" : `${"*".repeat(Math.min(8, id.length - 4))}${id.slice(-4)}`;
}

/** 🔴 只有平台後台（admin actor）能設定憑證；MCP 沒有任何設定或讀出 secret 的工具 */
export async function saveProviderAccount(ctx: ServiceContext, input: { site: string; provider: ProviderId; appId: string; secrets: Record<string, string>; sandbox: boolean }) {
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "金流憑證只能從平台後台表單輸入（不經過 agent 對話）");
  if (input.provider === "pchomepay") return savePaymentAccount(ctx, { site: input.site, appId: input.appId, secret: input.secrets.secret ?? "", sandbox: input.sandbox });
  const spec = PROVIDER_FIELDS[input.provider];
  if (!spec) throw new ServiceError("invalid", "不支援的金流");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const appId = input.appId.trim();
  if (!spec.idPattern.test(appId)) throw new ServiceError("invalid", `${spec.idLabel} 格式不正確`);
  const secret: Record<string, string> = {};
  for (const f of spec.secrets) {
    const v = (input.secrets[f.key] ?? "").trim();
    if (!v) {
      if (f.required) throw new ServiceError("invalid", `請輸入 ${f.label}`);
      continue;
    }
    if (v.length > 200 || (f.pattern && !f.pattern.test(v))) throw new ServiceError("invalid", `${f.label} 格式不正確`);
    secret[f.key] = v;
  }
  await ctx.store.upsertPaymentAccount({ tenant_id: tenant.id, provider: input.provider, sandbox: input.sandbox, app_id: appId, secret_enc: encryptSecret(JSON.stringify(secret), tenant.id) });
  await syncShopModuleStatus(ctx.store, tenant.id);
  await audit(ctx, tenant.id, "payment_account.save", { provider: input.provider, sandbox: input.sandbox, appId: maskId(appId) });
  return { saved: true, status: "unverified" as const, note: "憑證已加密儲存，請按「驗證」確認可用。" };
}

/** 依 DB 憑證建 provider（requireVerified：結帳建單只用已驗證的憑證） */
export async function providerClientFor(store: Store, tenantId: string, provider: ProviderId, opts: { requireVerified: boolean } = { requireVerified: true }): Promise<PaymentProvider | null> {
  const acct = await store.getPaymentAccount(tenantId, provider);
  if (!acct || (opts.requireVerified && acct.status !== "verified")) return null;
  return providerFromAccount(acct, tenantId);
}

export type ProviderFactory = (store: Store, tenantId: string, provider: ProviderId, opts: { requireVerified: boolean }) => Promise<PaymentProvider | null>;

/** 後台「驗證」：用該組憑證做無副作用的檢查（各家見 lib/pay/*.ts verifyCredentials） */
export async function verifyProviderAccount(ctx: ServiceContext, input: { site: string; provider: ProviderId }, factory: ProviderFactory = providerClientFor) {
  if (input.provider === "pchomepay") return verifyPaymentAccount(ctx, { site: input.site });
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "金流憑證只能從平台後台驗證");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const acct = await ctx.store.getPaymentAccount(tenant.id, input.provider);
  if (!acct) throw new ServiceError("invalid", `尚未輸入 ${PROVIDER_LABEL[input.provider]} 憑證`);
  const p = await factory(ctx.store, tenant.id, input.provider, { requireVerified: false });
  if (!p) throw new ServiceError("invalid", "憑證無法使用");
  // 第七批審查 H1／H2：平台網址太長會讓 callback 網址超過該家上限（藍新 MPG 200、定期定額 100）→ 設定時就拒絕／提示
  const sample = "X".repeat(SHORT_CODE_LEN);
  assertUrlLengths(shortPayUrls(ctx.baseUrl, sample, input.provider), CALLBACK_URL_LIMITS[input.provider], PROVIDER_LABEL[input.provider]);
  let periodOk = true;
  try {
    if (input.provider === "newebpay") assertUrlLengths(shortSubscriptionUrls(ctx.baseUrl, sample), NEWEBPAY_PERIOD_URL_LIMIT, "藍新定期定額");
  } catch {
    periodOk = false;
  }
  const r = await p.verifyCredentials();
  if (r.ok) await ctx.store.markPaymentAccount(tenant.id, input.provider, { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  else await ctx.store.markPaymentAccount(tenant.id, input.provider, { status: "unverified", verified_at: null, last_error: r.message.slice(0, 300) });
  await syncShopModuleStatus(ctx.store, tenant.id);
  if (input.provider === "newebpay") {
    // subscriptions 模組：藍新憑證驗證後才 enabled
    const row = (await ctx.store.listTenantModules(tenant.id)).find((m) => m.module_id === "subscriptions");
    if (row && row.status !== "disabled") {
      const want = r.ok && periodOk ? "enabled" : "pending_setup";
      if (row.status !== want) await ctx.store.upsertTenantModule({ ...row, status: want });
    }
  }
  await audit(ctx, tenant.id, "payment_account.verify", { provider: input.provider, ok: r.ok, sandbox: acct.sandbox });
  if (!r.ok) throw new ServiceError("invalid", `驗證失敗：${r.message}`);
  return { verified: true, sandbox: acct.sandbox, note: [r.note, periodOk ? null : `平台網址（${ctx.baseUrl}）太長，藍新定期定額的網址會超過 100 字上限，訂閱模組無法使用（平台網址需 ≤ ${MAX_BASE_URL_FOR_PERIOD} 字）`].filter(Boolean).join(" ") || undefined };
}

/** 舊版（第七批上線初期）callback／導回網址：帶 tenantId 與每筆 token。新付款一律用 lib/pay/urls.ts 的短網址；舊路由保留給還沒完成的舊付款 */
export function providerUrls(baseUrl: string, tenant: TenantRow, payment: Pick<PaymentRow, "id" | "gateway_order_no" | "provider">, orderNo: string, accessKey: string) {
  const base = baseUrl.replace(/\/$/, "");
  const orderUrl = orderPageUrl(base, tenant, orderNo, accessKey);
  const q = (purpose: "notify" | "return" | "confirm") => `p=${encodeURIComponent(payment.id)}&t=${payToken(purpose, payment.id)}`;
  return {
    orderUrl,
    notifyUrl: `${base}/api/pay/${payment.provider}/notify/${tenant.id}?${q("notify")}`,
    // 瀏覽器導回：只導到訂單頁（不改狀態）；表單 POST 回來的（藍新、PAYUNi）經 return 端點轉 303
    returnUrl:
      payment.provider === "linepay"
        ? `${base}/api/pay/linepay/confirm/${tenant.id}?${q("confirm")}&o=${encodeURIComponent(orderNo)}&k=${encodeURIComponent(accessKey)}`
        : payment.provider === "newebpay" || payment.provider === "payuni"
          ? `${base}/api/pay/${payment.provider}/return/${tenant.id}?${q("return")}&o=${encodeURIComponent(orderNo)}&k=${encodeURIComponent(accessKey)}`
          : orderUrl,
    cancelUrl: orderUrl,
  };
}

/**
 * 線上付款建單（所有 provider 的單一入口；PChomePay 走原本的 startPchomepayPayment，行為不變）。
 * 建 builder_payments（gateway_order_no 唯一）→ provider.createPayment → 回導轉網址或自動送出的表單。失敗標 failed 並丟錯（呼叫端取消訂單）。
 */
export async function startOnlinePayment(
  deps: { store: Store; baseUrl: string; clientFactory?: typeof pchomepayClientFor; providerFactory?: ProviderFactory },
  input: { tenant: TenantRow; order: OrderRow; accessKey: string },
): Promise<{ kind: "redirect"; url: string; gatewayOrderNo: string } | { kind: "form"; action: string; fields: Record<string, string>; gatewayOrderNo: string }> {
  const { tenant, order } = input;
  const method = order.payment_method;
  if (method === "pchomepay") {
    const r = await startPchomepayPayment({ store: deps.store, baseUrl: deps.baseUrl, clientFactory: deps.clientFactory }, input);
    return { kind: "redirect", url: r.paymentUrl, gatewayOrderNo: r.gatewayOrderNo };
  }
  if (order.status !== "pending_payment" || !isOnlineMethod(method)) throw new ServiceError("invalid", "這筆訂單不需要線上付款");
  const provider = await (deps.providerFactory ?? providerClientFor)(deps.store, tenant.id, method, { requireVerified: true });
  if (!provider) throw new ServiceError("invalid", "此商店目前無法使用這個付款方式");
  // 藍新 MerchantOrderNo 只接受英數＿、PAYUNi／黑貓 ≤ 25：GB 開頭 20 碼英數全部相容
  const gatewayOrderNo = genGatewayOrderNo();
  // 第七批審查 H1：短網址（藍新 MPG URL 上限 200 字；原本帶 tenant／token／訂單金鑰的網址 224 字）。超過上限直接拒絕，不送一定失敗的建單
  const shortCode = genShortCode();
  const urls = { ...shortPayUrls(deps.baseUrl, shortCode, method), orderUrl: orderPageUrl(deps.baseUrl, tenant, order.order_no, input.accessKey) };
  assertUrlLengths({ notifyUrl: urls.notifyUrl, returnUrl: urls.returnUrl, cancelUrl: urls.cancelUrl }, CALLBACK_URL_LIMITS[method], PROVIDER_LABEL[method]);
  const payment = await deps.store.insertPayment({ tenant_id: tenant.id, order_id: order.id, provider: method, gateway_order_no: gatewayOrderNo, amount: order.total, sandbox: provider.sandbox, short_code: shortCode, return_key_enc: encryptSecret(input.accessKey, tenant.id) });
  let r: Awaited<ReturnType<PaymentProvider["createPayment"]>> = null;
  try {
    r = await provider.createPayment({
      gatewayOrderNo,
      amount: order.total,
      itemName: `${tenant.name} 訂單 ${order.order_no}`,
      returnUrl: urls.returnUrl,
      notifyUrl: urls.notifyUrl,
      cancelUrl: urls.cancelUrl,
      buyerEmail: order.contact.email,
      expireMinutes: order.expires_at ? Math.max(1, Math.floor((new Date(order.expires_at).getTime() - Date.now()) / 60_000)) : undefined,
    });
  } catch (e) {
    console.error(`[${method}] 建單例外`, e instanceof Error ? e.message : e);
  }
  if (!r) {
    await deps.store.updatePayment(tenant.id, payment.id, { status: "failed" });
    throw new ServiceError("invalid", "金流建單失敗，請稍後再試或改用其他付款方式");
  }
  await deps.store.updatePayment(tenant.id, payment.id, { payment_url: r.kind === "redirect" ? r.url : r.action, gateway_trade_no: r.tradeNo ?? null });
  return r.kind === "redirect" ? { kind: "redirect", url: r.url, gatewayOrderNo } : { kind: "form", action: r.action, fields: r.fields, gatewayOrderNo };
}

/** 各家 callback 的回應格式（官方規定）。ok＝處理完不要再送；retry＝請對方重送；invalid＝簽章錯 */
export const CALLBACK_RESPONSES: Record<Exclude<ProviderId, "pchomepay" | "linepay">, { ok: { status: number; body: string }; retry: { status: number; body: string }; invalid: { status: number; body: string } }> = {
  // https://developers.ecpay.com.tw/2878/：必須回純文字 1|OK；其他回應綠界會重送（5–15 分鐘、當天最多 4 次）
  ecpay: { ok: { status: 200, body: "1|OK" }, retry: { status: 200, body: "0|Retry" }, invalid: { status: 200, body: "0|CheckMacValueError" } },
  // 藍新 NDNF-1.2.6 FAQ：只認 HTTP 200 為通知成功，未收到 200 會重送
  newebpay: { ok: { status: 200, body: "SUCCESS" }, retry: { status: 500, body: "retry" }, invalid: { status: 400, body: "invalid" } },
  // PAYUNi 文件未規定回應格式；回 200 OK、要求重送回 500
  payuni: { ok: { status: 200, body: "OK" }, retry: { status: 500, body: "retry" }, invalid: { status: 400, body: "invalid" } },
  // 黑貓 PAY 規格 V1.28.2：APN 必須回純文字 OK，否則每 15 分鐘重送、同狀態最多 3 次
  blackcat: { ok: { status: 200, body: "OK" }, retry: { status: 500, body: "retry" }, invalid: { status: 400, body: "invalid" } },
};

export type ProviderNotifyResult = { status: number; body: string; outcome: string };

/**
 * 藍新／綠界／PAYUNi／黑貓的 server 通知（天生公開）。安全規則（與 PChomePay 同）：
 * 1. 網址帶 tenantId 與每筆付款的 token（HMAC）；付款紀錄的 tenant／provider 必須相符。
 * 2. 用「該租戶自己的憑證」驗簽（常數時間；綠界 CheckMacValue、藍新 TradeSha＋AES、PAYUNi HashInfo＋AES-GCM、黑貓 checksum＋api_id）。
 * 3. 絕不信 payload：只取訂單號當查詢鍵，一律權威回查（環境必須與建單時相同）；金額、訂單號、租戶三重比對（settlePaid）。
 * 4. 無法辨識 → 不標記、要求重送、警示店主；回查失敗 → 要求重送、連續失敗警示。回應格式照各家規定（CALLBACK_RESPONSES）。
 */
export async function handleProviderNotify(
  deps: PayDeps,
  input: { provider: Exclude<ProviderId, "pchomepay" | "linepay">; tenantId: string; paymentId: string | null; token: string | null; rawBody: string; contentType: string },
): Promise<ProviderNotifyResult> {
  const fmt = CALLBACK_RESPONSES[input.provider];
  const ok = (outcome: string) => ({ ...fmt.ok, outcome });
  const retry = (outcome: string) => ({ ...fmt.retry, outcome });
  const invalid = (outcome: string) => ({ ...fmt.invalid, outcome });
  if (!input.paymentId || !verifyPayToken("notify", input.paymentId, input.token)) {
    console.error(`[${input.provider}/notify] token 不符 tenant=${input.tenantId}`);
    return invalid("bad_token");
  }
  const tenant = await deps.store.getTenantById(input.tenantId);
  if (!tenant) return ok("unknown_tenant");
  const acct = await deps.store.getPaymentAccount(tenant.id, input.provider);
  if (!acct) {
    console.error(`[${input.provider}/notify] 租戶沒有這家的憑證 tenant=${tenant.id}`);
    return retry("no_account");
  }
  const provider = deps.providerFor ? await deps.providerFor(tenant.id, input.provider, acct.sandbox) : providerFromAccount(acct, tenant.id);
  if (!provider?.verifyCallback) return retry("no_provider");
  const v = provider.verifyCallback(input.rawBody, input.contentType);
  if (!v.ok) {
    console.error(`[${input.provider}/notify] 🔴 簽章驗證失敗（${v.reason}）tenant=${tenant.id}`);
    return invalid(`signature:${v.reason}`);
  }
  const payment = await deps.store.getPaymentByGatewayNo(v.gatewayOrderNo);
  if (!payment || payment.tenant_id !== tenant.id || payment.provider !== input.provider || payment.id !== input.paymentId) {
    console.error(`[${input.provider}/notify] 找不到付款紀錄或租戶／provider 不符 tenant=${tenant.id} order=${v.gatewayOrderNo}`);
    return ok("unknown_payment");
  }
  const order = await deps.store.getOrderById(tenant.id, payment.order_id);
  if (!order) return ok("order_missing");
  if (payment.status === "paid" || payment.status === "paid_after_cancel") return ok(`already:${payment.status}`);
  const r = await queryAuthoritative(deps, tenant, payment, order.order_no, v.hint);
  if (payment.status === "failed") {
    // 之前回查為失敗（例如刷卡被拒），客人在同一筆付款頁重試成功：只有權威回查為已付才重新打開這筆付款
    if (r.kind === "query_failed") return retry("query_failed");
    // 第七批審查 L1：回查無法辨識 → 要求重送（已警示店主），不回 ok
    if (r.kind === "unknown") return retry(`unknown_status:${r.q.statusText}`);
    if (r.kind !== "paid") return ok(`already:failed`);
    if (!(await deps.store.transitionPayment(tenant.id, payment.id, "failed", "pending", {}))) return ok("already:changed");
    payment.status = "pending";
  }
  if (r.kind === "query_failed") return retry("query_failed");
  if (r.kind === "unknown") return retry(`unknown_status:${r.q.statusText}`);
  if (r.kind === "pending") {
    await deps.store.updatePayment(tenant.id, payment.id, { raw: { notify: v.hint ?? null, query: r.q.raw } });
    return ok(`not_paid:${r.q.statusText}`);
  }
  if (r.kind === "failed") {
    await deps.store.transitionPayment(tenant.id, payment.id, "pending", "failed", { raw: { notify: v.hint ?? null, query: r.q.raw } });
    return ok(`failed:${r.q.statusText}`);
  }
  const outcome = await settlePaid(deps, tenant, payment, order, r.q);
  if (outcome === "missing_amount") return retry("missing_amount");
  return ok(outcome);
}

/* ------------------------------------------------------------------ LINE Pay：導回後由商家 server confirm */

/** confirm 宣告逾時（卡住超過就可重新宣告；官方建議 confirm 逾時 ≥ 40 秒） */
export const LINEPAY_CONFIRM_STALE_MS = 2 * 60_000;

type LinepayConfirmCapable = PaymentProvider & { confirm(transactionId: string, amount: number): Promise<import("../pay/linepay").LinepayConfirmResult> };

/**
 * LINE Pay confirm（冪等）：
 * - 只有訂單仍待付款才 confirm（已取消／逾期 → 不 confirm，授權不請款會自動失效，客人不會被扣款）。
 * - 🔴 金額一律用 DB 的付款金額；同一 transactionId 只 confirm 一次（claimPaymentConfirm 條件式宣告）。
 * - 0000 → 已付；其他回應 → 用 Check API 權威回查（0123 已完成、0121／0122 失敗、0110 已授權未 confirm）；逾時 → 結果不明，留給逾期前回查。
 * 回傳 paid／failed／pending（還不知道，不可取消）。
 */
export async function confirmLinepayPayment(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderIn: OrderRow): Promise<"paid" | "failed" | "pending"> {
  const order = (await deps.store.getOrderById(tenant.id, orderIn.id)) ?? orderIn;
  if (payment.status !== "pending") return payment.status === "paid" ? "paid" : "failed";
  if (!payment.gateway_trade_no) return "failed";
  const provider = (deps.providerFor ? await deps.providerFor(tenant.id, "linepay", payment.sandbox) : await defaultProviderFor(deps.store, tenant.id, "linepay", payment.sandbox)) as LinepayConfirmCapable | null;
  if (!provider || typeof provider.confirm !== "function") return "pending";
  if (order.status !== "pending_payment") {
    // 第七批審查 M2：先用 Check API 權威回查再決定——
    // 已請款（0123）→ settlePaid（訂單已取消 → paid_after_cancel＋警示店主退款）；已授權未請款（0110）→ 不 confirm（授權會自動失效）、付款標 failed；
    // 回查失敗／無法辨識 → 先不動（逾期前回查或下次導回再試）
    const q = await queryAuthoritative(deps, tenant, payment, order.order_no);
    if (q.kind === "paid") {
      const out = await settlePaid(deps, tenant, payment, order, q.q);
      return out === "paid" || out === "already_processed" ? "paid" : out === "paid_after_cancel" ? "failed" : "pending";
    }
    if (q.kind === "query_failed" || q.kind === "unknown") return "pending";
    await deps.store.transitionPayment(tenant.id, payment.id, "pending", "failed", { raw: { reason: `order_${order.status}_not_confirmed`, query: q.q.raw } });
    return "failed";
  }
  if (!(await deps.store.claimPaymentConfirm(tenant.id, payment.id, new Date(Date.now() - LINEPAY_CONFIRM_STALE_MS).toISOString()))) return "pending";
  const c = await provider.confirm(payment.gateway_trade_no, payment.amount);
  if (c.kind === "ok") {
    // 第七批審查 L7：實收金額一定來自 LINE Pay（confirm 的 payInfo 或 Payment Details），取不到就不標記
    const out = await settlePaid(deps, tenant, payment, order, { amount: c.amount, raw: { confirm: c.raw } });
    return out === "paid" || out === "already_processed" ? "paid" : out === "paid_after_cancel" ? "failed" : "pending";
  }
  // 非 0000（含 1172 重複、逾時）：權威回查
  const r = await queryAuthoritative(deps, tenant, payment, order.order_no);
  if (r.kind === "paid") {
    const out = await settlePaid(deps, tenant, payment, order, r.q);
    return out === "paid" || out === "already_processed" ? "paid" : "pending";
  }
  if (r.kind === "failed") {
    await deps.store.transitionPayment(tenant.id, payment.id, "pending", "failed", { raw: { confirm: c.kind === "rejected" ? c.raw : { message: c.message }, query: r.q.raw } });
    return "failed";
  }
  if (r.kind === "pending" && r.q.needsConfirm && c.kind === "rejected") {
    // 第七批審查 M6：已授權但 confirm 被拒（例如金額不符）→ 不再重送 confirm：付款標 failed、警示店主；訂單照常逾期取消（授權未請款會自動失效）
    await deps.store.transitionPayment(tenant.id, payment.id, "pending", "failed", { raw: { confirm: c.raw, query: r.q.raw } });
    await alertOwner(deps, tenant, payment, order.order_no, `LINE Pay confirm 被拒（${c.code} ${c.message}），交易仍是已授權未請款，系統不會再 confirm`);
    return "failed";
  }
  // 放掉宣告讓下次（逾期前回查或客人重新整理）可以再試
  if (c.kind === "rejected") await deps.store.updatePayment(tenant.id, payment.id, { confirm_claimed_at: null, raw: { confirm: c.raw } });
  return "pending";
}

/** LINE Pay confirmUrl（瀏覽器 GET，沒有簽章）：驗 token、orderId／transactionId 必須等於付款紀錄，再交給 confirmLinepayPayment */
export async function handleLinepayConfirm(deps: PayDeps, input: { tenantId: string; paymentId: string | null; token: string | null; transactionId: string | null; orderId: string | null }): Promise<{ result: "paid" | "failed" | "pending" | "invalid"; orderNo?: string; tenant?: TenantRow }> {
  if (!input.paymentId || !verifyPayToken("confirm", input.paymentId, input.token)) return { result: "invalid" };
  const payment = input.orderId ? await deps.store.getPaymentByGatewayNo(input.orderId) : null;
  if (!payment || payment.id !== input.paymentId || payment.tenant_id !== input.tenantId || payment.provider !== "linepay") return { result: "invalid" };
  if (!input.transactionId || payment.gateway_trade_no !== input.transactionId) return { result: "invalid" };
  const tenant = await deps.store.getTenantById(payment.tenant_id);
  const order = tenant ? await deps.store.getOrderById(tenant.id, payment.order_id) : null;
  if (!tenant || !order) return { result: "invalid" };
  const result = await confirmLinepayPayment(deps, tenant, payment, order);
  return { result, orderNo: order.order_no, tenant };
}

/* ------------------------------------------------------------------ 退款（provider 有退款 API 的） */

/** 第七批審查 M1：退款成功後會撤回的副作用（確認訊息用） */
function refundEffectsText(o: OrderRow): string {
  if (o.status === "paid") return "退款成功後訂單會自動取消：回補庫存、退回點數折抵與儲值金、沖回這張訂單賺的點數與團主／推薦分潤、撤銷由這張訂單開通的課程與報名";
  if (o.status === "fulfilled") return "訂單已出貨：退款成功後不回補庫存（貨已寄出），但會退回點數折抵與儲值金、沖回這張訂單賺的點數與推薦分潤、撤銷由這張訂單開通的課程，付款標為已退款";
  return "訂單已取消（取消時已處理庫存與副作用），退款只把錢退回";
}

/**
 * 退款成功後的處理（refund_order 與人工確認 resolve_refund 共用；冪等）：
 * 付款 paid／paid_after_cancel → refunded；已付款訂單 → 取消（跑取消 hooks）；已出貨訂單 → refunded_at（同交易退回點數折抵／儲值金）＋跑取消側 hooks。
 */
async function afterRefundSucceeded(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, orderId: string, paymentId: string): Promise<{ cancelled: boolean; refundedMarked: boolean }> {
  for (const from of ["paid", "paid_after_cancel"] as const) if (await deps.store.transitionPayment(tenant.id, paymentId, from, "refunded", {})) break;
  const o = await deps.store.getOrderById(tenant.id, orderId);
  if (!o) return { cancelled: false, refundedMarked: false };
  if (o.status === "paid") {
    const c = await cancelOrderWithHooks(deps, tenant, o.id, ["paid"], "refunded");
    return { cancelled: c.transitioned, refundedMarked: false };
  }
  if (o.status === "fulfilled") {
    const moved = await deps.store.markOrderRefunded(tenant.id, o.id);
    if (moved) {
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system", action: "order.refunded_after_fulfil", payload: { orderNo: o.order_no } });
      await runCancelHooks(deps.store, tenant, moved, { sendMail: deps.sendMail, baseUrl: deps.baseUrl });
    }
    return { cancelled: false, refundedMarked: !!moved };
  }
  return { cancelled: false, refundedMarked: false };
}

/**
 * 全額退款（refund_order，orders:write＋confirm）。規則：
 * - 只退「已付款」的線上付款（含已取消後才付款的 paid_after_cancel），金額＝該筆付款金額（不超過已付；部分退款本版不做）。
 * - 🔴 只能退一次：builder_refunds 的 partial unique index（requested／succeeded／unknown 只能有一筆）先宣告、再呼叫 provider。
 * - 先退錢、成功才改狀態：provider 成功 → 退款 succeeded → afterRefundSucceeded（取消／標記已退款＋撤回副作用）。
 * - 🔴 第七批審查 H4：儲值訂單只在「入帳的儲值金全部收回得了」時自動退款，而且先收回（取消訂單＝收回儲值金）再退錢；
 *   客人已用掉一部分 → 拒絕自動退款（部分退款本版不做），提示先 cancel_order 收回可收回部分、再到金流後台只退對應金額。
 * - provider 確定失敗 → failed（可重新申請）；結果不明（逾時）→ unknown，不自動重送，查證後用 resolve_refund 標記結果。
 * - sandbox 付款只會打測試環境（回查與退款環境＝建單環境）。
 */
export async function refundOrder(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; reason?: string; confirm?: boolean }, factory?: (tenantId: string, provider: ProviderId, sandbox: boolean) => Promise<PaymentProvider | null>) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  const payments = (await ctx.store.listPaymentsForOrder(tenant.id, o.id)).filter((p) => p.status === "paid" || p.status === "paid_after_cancel");
  const payment = payments[0];
  if (!payment) throw new ServiceError("invalid", `訂單 ${o.order_no} 沒有已付款的線上付款紀錄（線下匯款請自行退款；已退款的不能再退）`);
  const label = PROVIDER_LABEL[payment.provider];
  const refunds = await ctx.store.listRefundsForOrder(tenant.id, o.id);
  const prior = refunds.find((r) => r.payment_id === payment.id && r.status !== "failed");
  if (prior) throw new ServiceError("conflict", prior.status === "succeeded" ? `訂單 ${o.order_no} 已退款（${twd(prior.amount)}），不能再退` : prior.status === "unknown" ? `訂單 ${o.order_no} 上一次退款結果不明，請先到 ${label} 後台確認，再用 resolve_refund 標記結果；不會重送` : `訂單 ${o.order_no} 退款處理中（超過 15 分鐘仍無結果會轉為「結果不明」，請到 ${label} 後台確認後用 resolve_refund 標記）`);
  const provider = factory ? await factory(tenant.id, payment.provider, payment.sandbox) : await defaultProviderFor(ctx.store, tenant.id, payment.provider, payment.sandbox);
  if (!provider?.refund) throw new ServiceError("invalid", `${label} 不支援自動退款（或未設定退刷密碼），請到 ${label} 商家後台人工退款`);
  const amount = payment.amount;
  // H4：儲值訂單
  const topupOrder = isTopupOrder(o);
  const topup = topupOrder ? await topupReversalPreview(ctx.store, tenant, o) : null;
  if (topupOrder) {
    // 第八批審查 M-1：儲值訂單一律走「先收回儲值金（取消訂單）→ 全數收回才退款」；已標成出貨的（第八批前的舊資料）無法用取消收回 → 不自動退款
    if (o.status === "fulfilled") throw new ServiceError("invalid", `儲值訂單 ${o.order_no} 被標成已出貨，無法先收回儲值金，不提供自動退款：請先調整儲值金（adjust_balance）收回，再到 ${label} 商家後台人工退款。`);
    if (topup && topup.used > 0) {
      throw new ServiceError("invalid", `儲值訂單 ${o.order_no}：${topupReversalText(topup)}。客人已用掉一部分，不提供自動全額退款（部分退款本版不做）：請先用 cancel_order（confirm）收回可收回的 ${twd(topup.reclaimable)}，再到 ${label} 商家後台人工退款（只退可收回部分對應的金額）。`);
    }
    if (!topup) {
      const st = await topupReclaimState(ctx.store, tenant, o);
      if (st.credited > 0 && st.reclaimed < st.credited) throw new ServiceError("invalid", `儲值訂單 ${o.order_no} 取消時只收回 ${twd(st.reclaimed)}（入帳 ${twd(st.credited)}），不提供自動全額退款：請到 ${label} 商家後台人工退款可收回部分對應的金額。`);
    }
  }
  requireConfirm(
    input.confirm,
    `退款 ${twd(amount)} 給訂單 ${o.order_no}（${label}${payment.sandbox ? "，測試環境" : ""}）會真的把錢退給客人且無法撤回。${refundEffectsText(o)}${topup ? `。儲值金：${topupReversalText(topup)}；會先收回儲值金再退款` : ""}`,
  );
  let refund;
  try {
    refund = await ctx.store.insertRefund({ tenant_id: tenant.id, order_id: o.id, payment_id: payment.id, provider: payment.provider, amount, requested_by: ctx.actor.label, reason: input.reason?.trim().slice(0, 200) || null });
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") throw new ServiceError("conflict", `訂單 ${o.order_no} 已有退款紀錄，不能重複退款`);
    throw e;
  }
  await audit(ctx, tenant.id, "order.refund_request", { orderNo: o.order_no, provider: payment.provider, amount, sandbox: payment.sandbox });
  const deps = { store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl };
  if (topupOrder && o.status === "paid") {
    // H4：先收回儲值金（取消訂單＝同一套冪等的收回）→ 確認全部收回 → 才退錢；收不足就不退（客人在這期間用掉了）
    await cancelOrderWithHooks(deps, tenant, o.id, ["paid"], "refund_reclaim");
    const st = await topupReclaimState(ctx.store, tenant, o);
    if (st.reclaimed < st.credited) {
      await ctx.store.transitionRefund(tenant.id, refund.id, "requested", "failed", { error: `儲值金只收回 ${st.reclaimed}／${st.credited}，未自動退款` });
      await audit(ctx, tenant.id, "order.refund_reclaim_short", { orderNo: o.order_no, credited: st.credited, reclaimed: st.reclaimed });
      throw new ServiceError("invalid", `訂單已取消並收回儲值金 ${twd(st.reclaimed)}，但客人在這期間用掉了 ${twd(st.credited - st.reclaimed)}，沒有自動退款：請到 ${label} 商家後台人工退款可收回部分對應的金額。`);
    }
  }
  let r: Awaited<ReturnType<NonNullable<PaymentProvider["refund"]>>>;
  try {
    r = await provider.refund({ gatewayOrderNo: payment.gateway_order_no, amount, tradeNo: payment.gateway_trade_no ?? null });
  } catch (e) {
    r = { kind: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
  if (r.kind === "ok") {
    await ctx.store.transitionRefund(tenant.id, refund.id, "requested", "succeeded", { provider_refund_no: r.refundNo ?? null, raw: r.raw });
    await audit(ctx, tenant.id, "order.refund", { orderNo: o.order_no, provider: payment.provider, amount });
    const after = await afterRefundSucceeded(deps, tenant, o.id, payment.id);
    await mailSafe(ctx, o.contact.email, `【${tenant.name}】訂單 ${o.order_no} 已退款`, `${o.contact.name} 你好，\n\n訂單 ${o.order_no} 已透過 ${label} 退款 ${twd(amount)}。實際入帳時間依發卡銀行／錢包而定。`);
    const cancelled = after.cancelled || (topupOrder && o.status === "paid");
    return { refunded: true, amount, status: "succeeded" as const, orderCancelled: cancelled, refundedAfterFulfil: after.refundedMarked, note: `已退款 ${twd(amount)}${cancelled ? "，訂單已取消" : after.refundedMarked ? "，訂單標為已退款（已撤回點數、分潤與權益）" : ""}。` };
  }
  if (r.kind === "rejected") {
    await ctx.store.transitionRefund(tenant.id, refund.id, "requested", "failed", { error: r.message.slice(0, 300), raw: r.raw ?? null });
    await audit(ctx, tenant.id, "order.refund_failed", { orderNo: o.order_no, provider: payment.provider, message: r.message.slice(0, 200) });
    throw new ServiceError("invalid", `退款失敗：${r.message}${topupOrder && o.status === "paid" ? "（訂單已取消並收回儲值金，可再用 refund_order 重試退款）" : ""}`);
  }
  await ctx.store.transitionRefund(tenant.id, refund.id, "requested", "unknown", { error: r.message.slice(0, 300), raw: r.raw ?? null });
  await audit(ctx, tenant.id, "order.refund_unknown", { orderNo: o.order_no, provider: payment.provider, message: r.message.slice(0, 200) });
  return { refunded: false, amount, status: "unknown" as const, orderCancelled: false, note: `退款結果不明（${r.message}）。請到 ${label} 商家後台確認是否已退款，再用 resolve_refund 標記結果；系統不會自動重送。` };
}

/**
 * 第七批審查 L2：卡住（requested）或結果不明（unknown）的退款，店主到金流後台查證後標記結果（orders:write＋confirm）。
 * succeeded → 跑退款成功後的處理（冪等）；failed → 可重新申請退款。
 */
export async function resolveRefund(ctx: ServiceContext, input: { site?: string | null; refundId: string; outcome: "succeeded" | "failed"; note?: string; confirm?: boolean }) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const rf = await ctx.store.getRefund(tenant.id, input.refundId);
  if (!rf) throw new ServiceError("not_found", "找不到退款紀錄");
  if (rf.status !== "requested" && rf.status !== "unknown") throw new ServiceError("conflict", `這筆退款已是「${rf.status}」，不能再標記`);
  // 第八批審查 L-3：requested＝可能還在等金流回應；超過 REFUND_STALE_MINUTES 才允許人工標記（避免與進行中的退款請求互相覆蓋）
  if (rf.status === "requested" && Date.parse(rf.created_at) > Date.now() - REFUND_STALE_MINUTES * 60_000) throw new ServiceError("conflict", `這筆退款送出不到 ${REFUND_STALE_MINUTES} 分鐘，可能還在處理中；請稍後再確認（超過 ${REFUND_STALE_MINUTES} 分鐘仍無結果會轉為「結果不明」）`);
  if (input.outcome !== "succeeded" && input.outcome !== "failed") throw new ServiceError("invalid", "outcome 需為 succeeded 或 failed");
  const order = await ctx.store.getOrderById(tenant.id, rf.order_id);
  requireConfirm(input.confirm, `把退款（${twd(rf.amount)}，${PROVIDER_LABEL[rf.provider]}）標記為「${input.outcome === "succeeded" ? "已退款成功" : "退款失敗"}」——請先到金流商家後台確認${input.outcome === "succeeded" && order ? `。${refundEffectsText(order)}` : ""}`);
  const moved = await ctx.store.transitionRefund(tenant.id, rf.id, rf.status, input.outcome, { error: input.note?.trim().slice(0, 300) || (input.outcome === "failed" ? "店主確認退款失敗" : null) });
  if (!moved) throw new ServiceError("conflict", "退款狀態已被其他操作改變，請重新讀取");
  await audit(ctx, tenant.id, "order.refund_resolve", { refundId: rf.id, outcome: input.outcome, orderNo: order?.order_no ?? null });
  const after = input.outcome === "succeeded" ? await afterRefundSucceeded({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, rf.order_id, rf.payment_id) : null;
  return { refundId: rf.id, status: input.outcome, orderCancelled: !!after?.cancelled, refundedAfterFulfil: !!after?.refundedMarked };
}

/** 退款狀態查詢用（get_order 已附 refunds；這裡給 MCP 列出卡住的） */
export const REFUND_STALE_MINUTES = 15;

/** 每日 cron：requested 超過 15 分鐘仍無結果（程序中斷或逾時）→ 轉 unknown（不自動重送）並警示店主查證後用 resolve_refund 標記 */
export async function sweepStaleRefunds(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, now = Date.now()) {
  const stale = await deps.store.listStaleRefunds(new Date(now - REFUND_STALE_MINUTES * 60_000).toISOString(), 100);
  let marked = 0;
  for (const rf of stale) {
    if (!(await deps.store.transitionRefund(rf.tenant_id, rf.id, "requested", "unknown", { error: "退款請求逾時未回報結果（程序可能中斷），請到金流後台確認" }))) continue;
    marked++;
    const tenant = await deps.store.getTenantById(rf.tenant_id);
    const order = tenant ? await deps.store.getOrderById(tenant.id, rf.order_id) : null;
    if (!tenant) continue;
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system", action: "order.refund_stale", payload: { refundId: rf.id, orderNo: order?.order_no ?? null } });
    const settings = await publishedShopSettings(deps.store, tenant);
    if (settings.ownerEmail) await mailSafe(deps, settings.ownerEmail, `⚠️【${tenant.name}】退款結果不明 ${order?.order_no ?? ""}`, `訂單 ${order?.order_no ?? rf.order_id} 的 ${PROVIDER_LABEL[rf.provider]} 退款（${twd(rf.amount)}）送出後一直沒有結果。系統不會自動重送。\n請到 ${PROVIDER_LABEL[rf.provider]} 商家後台確認是否已退款，再到後台訂單頁（或 MCP resolve_refund）標記結果。`);
  }
  return { scanned: stale.length, marked };
}
