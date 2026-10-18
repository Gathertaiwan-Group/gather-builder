import type { OrderRow, OrderStatus, PaymentRow, Store, TenantRow } from "../store/types";
import { ORDER_STATUS_LABEL, assertTransition, canTransition, sourcesFor } from "../shop/machine";
import { PAID_STATUS_CODES, createPchomepayClient, genGatewayOrderNo, type PchomepayClient, type PchomepayQuery } from "../pay/pchomepay";
import { decryptSecret, encryptSecret } from "../secretbox";
import { ServiceError, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { mailSafe, orderPageUrl, publishedShopSettings, requireShop, twd, type CheckoutDeps } from "./shop";

type Mailer = CheckoutDeps["sendMail"];

/* ================================================================== 逾期 */

/**
 * 逾期未付 → 取消並回補庫存（冪等：條件式取消，重複呼叫只會成功一次）。
 * 讀訂單時 lazy 呼叫；另有每日 cron 掃一遍（/api/cron/expire-orders）。
 */
export async function expireIfDue(store: Store, order: OrderRow, now = Date.now()): Promise<OrderRow> {
  if (order.status !== "pending_payment" || !order.expires_at || new Date(order.expires_at).getTime() > now) return order;
  const r = await store.cancelOrder(order.tenant_id, order.id, ["pending_payment"], "expired");
  if (r.transitioned) {
    await store.insertAudit({ tenant_id: order.tenant_id, actor: "system", action: "order.expire", payload: { orderNo: order.order_no, stockReleased: r.stockReleased } });
  }
  return (await store.getOrderById(order.tenant_id, order.id)) ?? order;
}

export async function expireDueOrders(store: Store, limit = 200): Promise<{ scanned: number; expired: number }> {
  const due = await store.listExpiredPendingOrders(new Date().toISOString(), limit);
  let expired = 0;
  for (const d of due) {
    const o = await store.getOrderById(d.tenant_id, d.id);
    if (!o) continue;
    const after = await expireIfDue(store, o);
    if (after.status === "cancelled" && o.status === "pending_payment") expired++;
  }
  return { scanned: due.length, expired };
}

/* ================================================================== 讀取 */

function orderSummary(o: OrderRow) {
  return {
    id: o.id,
    orderNo: o.order_no,
    status: o.status,
    statusLabel: ORDER_STATUS_LABEL[o.status],
    paymentMethod: o.payment_method,
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
  return expireIfDue(ctx.store, o);
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
    for (const o of due) await expireIfDue(ctx.store, o);
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
export async function onOrderPaid(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, order: OrderRow, via: string) {
  const settings = await publishedShopSettings(deps.store, tenant);
  const url = orderPageUrl(deps.baseUrl, tenant, order.order_no);
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
  return { ...orderSummary(after), stockReleased: r.stockReleased, refundRequired: !!refundNote, note: refundNote ?? "訂單已取消，庫存已回補。" };
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
    note: "憑證只能由平台擁有者在後台「金流設定」輸入並驗證；MCP 無法設定或讀出金鑰。",
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
 * PChomePay notify（天生公開、沒有簽章）。安全規則：
 * 1. 絕不信 payload：只取 order_id 當查詢鍵，一律 GET /v1/payment/{order_id} 回查權威狀態（用該租戶自己的憑證）。
 * 2. status_code ∈ {S,00,1} 才算付款；金額 round 後必須等於訂單金額，不符不標記。
 * 3. 回查失敗回 500（讓對方重試）；其餘處理完一律回純文字 success。
 * 4. 條件式更新（where status='pending_payment'）：只有真正轉換成功的那一次才跑副作用，重複 notify 冪等。
 * 5. 訂單已取消／逾期卻收到付款 → 不改訂單狀態、寫 log、寄店主警示（需人工退款），警示也只寄一次。
 */
export async function handlePchomepayNotify(
  deps: { store: Store; sendMail?: Mailer; baseUrl: string; queryFor?: (tenantId: string) => Promise<Pick<PchomepayClient, "queryPayment"> | null> },
  input: { tenantId: string; rawBody: string },
): Promise<NotifyResult> {
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

  const queryFor = deps.queryFor ?? (async (tid: string) => (await pchomepayClientFor(deps.store, tid, { requireVerified: false }))?.client ?? null);
  let q: PchomepayQuery | null = null;
  try {
    const client = await queryFor(tenant.id);
    q = client ? await client.queryPayment(orderId) : null;
  } catch (e) {
    console.error(`[pchomepay/notify] 回查例外 order=${orderId}`, e instanceof Error ? e.message : e);
  }
  if (!q) {
    console.error(`[pchomepay/notify] 回查失敗，回 500 待重試 order=${orderId}`);
    return retry("query_failed");
  }
  const raw = { notifyType, query: q.raw };
  if (!PAID_STATUS_CODES.has(String(q.status_code ?? ""))) {
    await deps.store.updatePayment(tenant.id, payment.id, { raw });
    return ok(`not_paid:${q.status_code ?? "?"}`);
  }
  if (q.amount == null || !Number.isFinite(q.amount)) {
    console.error(`[pchomepay/notify] 權威已付但缺 amount，回 500 待重試 order=${orderId}`);
    return retry("missing_amount");
  }
  let order = await deps.store.getOrderById(tenant.id, payment.order_id);
  if (!order) return ok("order_missing");
  const expected = Math.round(payment.amount);
  if (Math.round(q.amount) !== expected || Math.round(order.total) !== expected) {
    console.error(`[pchomepay/notify] 金額不符，不標記付款！order=${order.order_no} gateway=${orderId} 期望=${expected} 權威=${q.amount}`);
    await deps.store.updatePayment(tenant.id, payment.id, { raw });
    return ok("amount_mismatch");
  }
  const paidAt = new Date().toISOString();

  if (order.status === "pending_payment") {
    const moved = await deps.store.transitionOrder(tenant.id, order.id, "pending_payment", "paid", { paid_at: paidAt });
    if (moved) {
      await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid", { raw, paid_at: paidAt });
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "pchomepay", action: "order.paid", payload: { orderNo: moved.order_no, gatewayOrderNo: orderId, sandbox: payment.sandbox } });
      await onOrderPaid(deps, tenant, moved, `PChomePay${payment.sandbox ? "（測試環境）" : ""}`);
      return ok("paid");
    }
    order = (await deps.store.getOrderById(tenant.id, order.id)) ?? order;
  }

  if (order.status === "cancelled") {
    // 已取消／逾期的訂單收到付款：不改訂單狀態，警示店主人工退款（只在第一次轉換時寄）
    const first = await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid_after_cancel", { raw, paid_at: paidAt });
    console.error(`[pchomepay/notify] 🔴 已取消的訂單收到付款，需人工退款 order=${order.order_no} gateway=${orderId} amount=${q.amount} first=${first}`);
    if (first) {
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "pchomepay", action: "order.paid_after_cancel", payload: { orderNo: order.order_no, gatewayOrderNo: orderId, amount: q.amount } });
      const settings = await publishedShopSettings(deps.store, tenant);
      if (settings.ownerEmail) {
        await mailSafe(
          deps,
          settings.ownerEmail,
          `🔴【${tenant.name}】已取消的訂單收到付款，請人工退款 ${order.order_no}`,
          `訂單 ${order.order_no}（${order.cancel_reason === "expired" ? "逾期自動取消" : "已取消"}）收到 PChomePay 付款 ${twd(Math.round(q.amount))}。\n閘道訂單編號：${orderId}\n系統沒有改變訂單狀態，請到 PChomePay 商家後台退款，或與客人（${order.contact.name} ${order.contact.email}）聯繫。`,
        );
      }
    }
    return ok("paid_after_cancel");
  }

  // 已是 paid／fulfilled（重複 notify 或已手動處理）：只補記付款紀錄，不重跑副作用
  await deps.store.transitionPayment(tenant.id, payment.id, "pending", "paid", { raw, paid_at: paidAt });
  return ok("already_processed");
}

export type { PaymentRow };
