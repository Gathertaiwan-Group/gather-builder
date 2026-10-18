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
import { decryptSecret, encryptSecret } from "../secretbox";
import { ServiceError, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { mailSafe, orderPageUrl, publishedShopSettings, requireShop, twd, type CheckoutDeps } from "./shop";

type Mailer = CheckoutDeps["sendMail"];

/* ================================================================== 逾期 */

/** 權威回查的依賴（notify 與逾期處理共用） */
export interface PayDeps {
  store: Store;
  sendMail?: Mailer;
  baseUrl: string;
  /** 依「建單時的環境」取查單 client；環境與目前憑證不符（L1）或沒有憑證回 null */
  queryFor?: (tenantId: string, sandbox: boolean) => Promise<Pick<PchomepayClient, "queryPayment"> | null>;
}

const ctxPayDeps = (ctx: ServiceContext): PayDeps => ({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl });

/** 回查連續失敗幾次就警示店主 */
export const QUERY_FAILURE_ALERT_AT = 3;

function defaultPayDeps(store: Store): PayDeps {
  return { store, sendMail: getMailer(), baseUrl: (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "") };
}

async function defaultQueryFor(store: Store, tenantId: string, sandbox: boolean) {
  const acct = await store.getPaymentAccount(tenantId, "pchomepay");
  if (!acct) return null;
  // L1：付款是在 sandbox 建的就只能用 sandbox 憑證回查（反之亦然）；換過環境 → 不回查（當成失敗，稍後重試＋警示）
  if (acct.sandbox !== sandbox) {
    console.error(`[pchomepay] 憑證環境（${acct.sandbox ? "sandbox" : "正式"}）與付款建單環境（${sandbox ? "sandbox" : "正式"}）不符，拒絕回查 tenant=${tenantId}`);
    return null;
  }
  return (await pchomepayClientFor(store, tenantId, { requireVerified: false }))?.client ?? null;
}

/** 回查異常警示（同一筆付款只寄一次：alerted_at 條件更新） */
async function alertOwner(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderNo: string, reason: string) {
  if (!(await deps.store.markPaymentAlerted(tenant.id, payment.id))) return;
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system", action: "payment.query_alert", payload: { orderNo, gatewayOrderNo: payment.gateway_order_no, reason } });
  const settings = await publishedShopSettings(deps.store, tenant);
  if (settings.ownerEmail) {
    await mailSafe(
      deps,
      settings.ownerEmail,
      `⚠️【${tenant.name}】線上付款狀態無法確認 ${orderNo}`,
      `訂單 ${orderNo}（閘道編號 ${payment.gateway_order_no}）向 PChomePay 回查付款狀態時發生問題：${reason}\n系統不會自動取消這張訂單，會持續重試。請到 PChomePay 商家後台確認是否已收款。`,
    );
  }
}

type QueryOutcome =
  | { kind: "query_failed" }
  | { kind: "unknown"; q: PchomepayQuery }
  | { kind: "pending"; q: PchomepayQuery }
  | { kind: "failed"; q: PchomepayQuery }
  | { kind: "paid"; q: PchomepayQuery };

/** 對一筆付款做權威回查並分類；回查失敗會累計次數，達門檻警示店主 */
async function queryAuthoritative(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderNo: string): Promise<QueryOutcome> {
  let q: PchomepayQuery | null = null;
  let err = "回查失敗";
  try {
    const client = deps.queryFor ? await deps.queryFor(tenant.id, payment.sandbox) : await defaultQueryFor(deps.store, tenant.id, payment.sandbox);
    if (!client) err = "沒有可用的憑證，或憑證環境與建單時不符";
    q = client ? await client.queryPayment(payment.gateway_order_no) : null;
  } catch (e) {
    err = `回查例外：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!q) {
    const n = await deps.store.bumpPaymentQueryFailure(tenant.id, payment.id, err);
    console.error(`[pchomepay] ${err}（第 ${n} 次）order=${orderNo} gateway=${payment.gateway_order_no}`);
    if (n >= QUERY_FAILURE_ALERT_AT) await alertOwner(deps, tenant, payment, orderNo, `連續 ${n} 次回查失敗（${err}）`);
    return { kind: "query_failed" };
  }
  const state = classifyPchomepayQuery(q);
  if (state === "unknown") {
    console.error(`[pchomepay] 🔴 無法辨識的查單狀態 status=${q.status ?? "-"} status_code=${q.status_code ?? "-"} order=${orderNo}`);
    await deps.store.updatePayment(tenant.id, payment.id, { raw: { query: q.raw } });
    await alertOwner(deps, tenant, payment, orderNo, `無法辨識的付款狀態（status=${q.status ?? "-"}, status_code=${q.status_code ?? "-"}）`);
    return { kind: "unknown", q };
  }
  if (payment.query_failures) await deps.store.updatePayment(tenant.id, payment.id, { query_failures: 0, last_query_error: null });
  return { kind: state, q };
}

/**
 * 逾期未付 → 取消並回補庫存（冪等：條件式取消，重複呼叫只會成功一次）。
 * 讀訂單時 lazy 呼叫；另有每日 cron 掃一遍（/api/cron/expire-orders）。
 * 🔴 H2：線上付款訂單取消前，先對所有 pending 付款做權威回查——
 *   已付 → 走正常付款流程（不取消）；回查失敗或狀態無法辨識 → 這次不取消（下次再試），連續失敗警示店主。
 */
export async function expireIfDue(store: Store, order: OrderRow, now = Date.now(), deps?: PayDeps): Promise<OrderRow> {
  if (order.status !== "pending_payment" || !order.expires_at || new Date(order.expires_at).getTime() > now) return order;
  if (order.payment_method === "pchomepay") {
    const d = deps ?? defaultPayDeps(store);
    const tenant = await store.getTenantById(order.tenant_id);
    if (!tenant) return order;
    const pending = (await store.listPaymentsForOrder(order.tenant_id, order.id)).filter((p) => p.status === "pending");
    for (const p of pending) {
      const r = await queryAuthoritative(d, tenant, p, order.order_no);
      if (r.kind === "query_failed" || r.kind === "unknown") return order; // 不確定就不取消
      if (r.kind === "paid") {
        await settlePaid(d, tenant, p, order, r.q);
        return (await store.getOrderById(order.tenant_id, order.id)) ?? order;
      }
      if (r.kind === "failed") await store.transitionPayment(order.tenant_id, p.id, "pending", "failed", { raw: { query: r.q.raw } });
      // pending（P／W*）＝客人沒完成付款，可以取消
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
export async function retryOrderHooks(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, opts: { orderId?: string; limit?: number } = {}) {
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
    shippingChoice: o.shipping_choice,
    // 付款紀錄只給狀態，不給閘道原始回應
    payments: payments.map((p) => ({ provider: p.provider, gatewayOrderNo: p.gateway_order_no, amount: p.amount, status: p.status, sandbox: p.sandbox, paidAt: p.paid_at, createdAt: p.created_at })),
    allowedNext: (["paid", "fulfilled", "cancelled"] as OrderStatus[]).filter((s) => canTransition(o.status, s)),
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
        : "此訂單已收款（線下匯款）：取消不會自動退款，請自行退款給客人。"
      : null;
  requireConfirm(input.confirm, `取消訂單 ${o.order_no} 會回補庫存且無法復原${refundNote ? `。注意：${refundNote}` : ""}`);
  const r = await ctx.store.cancelOrder(tenant.id, o.id, sourcesFor("cancelled").filter((s) => s === o.status), input.reason?.trim().slice(0, 200) || "cancelled_by_shop");
  if (!r.transitioned) throw new ServiceError("conflict", `訂單 ${o.order_no} 狀態已被其他操作改變，請重新讀取`);
  await audit(ctx, tenant.id, "order.cancel", { orderNo: o.order_no, from: o.status, stockReleased: r.stockReleased });
  const after = (await ctx.store.getOrderById(tenant.id, o.id))!;
  await runCancelHooks(ctx.store, tenant, after, { sendMail: ctx.sendMail, baseUrl: ctx.baseUrl });
  // 已開立發票的訂單取消：提示作廢（同期）或折讓（跨期）
  const inv = await ctx.store.getInvoiceByOrder(tenant.id, o.id);
  const invoiceNote = inv?.status === "issued" ? `此訂單已開立發票 ${inv.invoice_no}：請用 void_invoice（confirm: true）處理——同一期會作廢，跨期會改開折讓單。` : null;
  return {
    ...orderSummary(after),
    stockReleased: r.stockReleased,
    refundRequired: !!refundNote,
    invoiceActionRequired: !!invoiceNote,
    note: [refundNote ?? "訂單已取消，庫存已回補。", invoiceNote].filter(Boolean).join(" "),
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
  const [acct, states, settings] = await Promise.all([ctx.store.getPaymentAccount(tenant.id, "pchomepay"), moduleStates(ctx, tenant.id), publishedShopSettings(ctx.store, tenant)]);
  return {
    shopModuleStatus: states.get("shop")?.status ?? "disabled",
    pchomepay: acct
      ? { configured: true, status: acct.status, sandbox: acct.sandbox, appId: maskAppId(acct.app_id), verifiedAt: acct.verified_at, lastError: acct.last_error }
      : { configured: false, status: "not_configured" },
    offlineTransfer: { enabled: !!settings.offlineTransfer?.enabled },
    note: `憑證只能由平台擁有者在後台「金流設定」輸入並驗證；MCP 無法設定或讀出金鑰。${acct?.sandbox ? "目前是測試環境（sandbox）憑證：只有帶預覽簽章的結帳能用線上付款，已發布網站的訪客看不到線上付款；正式營業前請換成正式憑證。" : ""}`,
  };
}

/** shop 模組狀態：沒有已驗證的 PChomePay 憑證 → pending_setup（仍可只用線下匯款） */
export async function syncShopModuleStatus(store: Store, tenantId: string) {
  const row = (await store.listTenantModules(tenantId)).find((m) => m.module_id === "shop");
  if (!row || row.status === "disabled") return;
  const acct = await store.getPaymentAccount(tenantId, "pchomepay");
  const want = acct?.status === "verified" ? "enabled" : "pending_setup";
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
async function settlePaid(deps: PayDeps, tenant: TenantRow, payment: PaymentRow, orderIn: OrderRow, q: PchomepayQuery): Promise<"paid" | "missing_amount" | "amount_mismatch" | "paid_after_cancel" | "already_processed" | "order_missing"> {
  const gw = payment.gateway_order_no;
  if (q.amount == null || !Number.isFinite(q.amount)) {
    console.error(`[pchomepay] 權威已付但缺 amount，待重試 order=${gw}`);
    return "missing_amount";
  }
  let order = (await deps.store.getOrderById(tenant.id, orderIn.id)) ?? null;
  if (!order) return "order_missing";
  const raw = { query: q.raw };
  const expected = Math.round(payment.amount);
  if (Math.round(q.amount) !== expected || Math.round(order.total) !== expected) {
    console.error(`[pchomepay] 金額不符，不標記付款！order=${order.order_no} gateway=${gw} 期望=${expected} 權威=${q.amount}`);
    await deps.store.updatePayment(tenant.id, payment.id, { raw });
    return "amount_mismatch";
  }
  const paidAt = new Date().toISOString();
  if (order.status === "pending_payment") {
    // M3：sandbox 付款在同一交易釋放報名／預約保留（測試付款不佔名額）
    const moved = payment.sandbox ? await deps.store.markPaidSandbox(tenant.id, order.id, paidAt) : await deps.store.transitionOrder(tenant.id, order.id, "pending_payment", "paid", { paid_at: paidAt });
    if (moved) {
      await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid", { raw, paid_at: paidAt });
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "pchomepay", action: "order.paid", payload: { orderNo: moved.order_no, gatewayOrderNo: gw, sandbox: payment.sandbox } });
      await onOrderPaid(deps, tenant, moved, `PChomePay${payment.sandbox ? "（測試環境）" : ""}`, { sandbox: payment.sandbox });
      // sandbox：保留已釋放 → 跑取消側的 hook（候補遞補等；各 hook 冪等，未開通的東西不會被動到）
      if (payment.sandbox) await runCancelHooks(deps.store, tenant, moved, { sendMail: deps.sendMail, baseUrl: deps.baseUrl });
      return "paid";
    }
    order = (await deps.store.getOrderById(tenant.id, order.id)) ?? order;
  }
  if (order.status === "cancelled") {
    const first = await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid_after_cancel", { raw, paid_at: paidAt });
    console.error(`[pchomepay] 🔴 已取消的訂單收到付款，需人工退款 order=${order.order_no} gateway=${gw} amount=${q.amount} first=${first}`);
    if (first) {
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "pchomepay", action: "order.paid_after_cancel", payload: { orderNo: order.order_no, gatewayOrderNo: gw, amount: q.amount, sandbox: payment.sandbox } });
      const settings = await publishedShopSettings(deps.store, tenant);
      if (settings.ownerEmail) {
        await mailSafe(
          deps,
          settings.ownerEmail,
          `🔴【${tenant.name}】已取消的訂單收到付款，請人工退款 ${order.order_no}${payment.sandbox ? "（測試環境）" : ""}`,
          `訂單 ${order.order_no}（${order.cancel_reason === "expired" ? "逾期自動取消" : "已取消"}）收到 PChomePay 付款 ${twd(Math.round(q.amount))}。\n閘道訂單編號：${gw}\n系統沒有改變訂單狀態，請到 PChomePay 商家後台退款，或與客人（${order.contact.name} ${order.contact.email}）聯繫。`,
        );
      }
    }
    return "paid_after_cancel";
  }
  // 已是 paid／fulfilled（重複 notify 或已手動處理）：只補記付款紀錄，不重跑副作用
  await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid", { raw, paid_at: paidAt });
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
  if (r.kind === "unknown") return retry(`unknown_status:${r.q.status ?? "-"}/${r.q.status_code ?? "-"}`);
  if (r.kind === "pending") {
    await deps.store.updatePayment(tenant.id, payment.id, { raw: { notifyType, query: r.q.raw } });
    return ok(`not_paid:${r.q.status ?? r.q.status_code ?? "?"}`);
  }
  if (r.kind === "failed") {
    await deps.store.transitionPayment(tenant.id, payment.id, "pending", "failed", { raw: { notifyType, query: r.q.raw } });
    return ok(`failed:${r.q.status_code ?? r.q.status ?? "F"}`);
  }
  const outcome = await settlePaid(deps, tenant, payment, order, r.q);
  if (outcome === "missing_amount") return retry("missing_amount");
  return ok(outcome);
}

export type { PaymentRow };
