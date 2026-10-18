import { randomBytes } from "node:crypto";
import { invoiceSettings, type InvoiceSettings } from "@/modules/invoice/manifest";
import type { InvoiceProviderId, InvoiceRow, OrderRow, Store, TenantRow } from "../store/types";
import { decryptSecret, encryptSecret } from "../secretbox";
import { amegoRelayFromEnv, createAmegoProvider } from "../invoice/amego";
import { createMockProvider } from "../invoice/mock";
import { canVoidInPeriod, invoiceLines, type InvoiceProvider } from "../invoice/provider";
import { isValidTaxId } from "../invoice/validate";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { publishedModuleSettings } from "./members";
import { twd } from "./shop";

/* ================================================================== 供應商 */

type ProviderFactory = (store: Store, tenantId: string) => Promise<InvoiceProvider | null>;

/** 依 DB 憑證建供應商（解密只在 server 記憶體）；沒有憑證回 null */
export const defaultInvoiceProviderFactory: ProviderFactory = async (store, tenantId) => {
  const acct = await store.getInvoiceAccount(tenantId);
  if (!acct) return null;
  if (acct.provider === "mock") return createMockProvider();
  return createAmegoProvider({ sellerTaxId: acct.seller_tax_id, appKey: decryptSecret(acct.secret_enc, tenantId), ...amegoRelayFromEnv() });
};

let providerFactory: ProviderFactory = defaultInvoiceProviderFactory;
/** 測試用：換掉供應商工廠（回傳還原函式） */
export function setInvoiceProviderFactoryForTests(f: ProviderFactory): () => void {
  providerFactory = f;
  return () => {
    providerFactory = defaultInvoiceProviderFactory;
  };
}

/** 宣告後多久沒結果視為卡住（可重新宣告，但一定先反查） */
export const ISSUING_STALE_MS = 10 * 60_000;
/** cron 自動重試上限（永久錯誤直接設到上限，只能人工重試） */
export const MAX_AUTO_ATTEMPTS = 5;

/* ================================================================== 共用 */

export async function invoiceActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("invoice");
}

async function requireInvoice(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await invoiceActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「invoice」，請先 enable_module invoice");
}

export async function publishedInvoiceSettings(store: Store, tenant: TenantRow): Promise<InvoiceSettings> {
  return (await publishedModuleSettings(store, tenant, "invoice")) as InvoiceSettings;
}

function requireConfirm(confirm: boolean | undefined, what: string) {
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

function requireAdminActor(ctx: ServiceContext) {
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "發票憑證只能從平台後台表單輸入（不經過 agent 對話）");
}

const STATUS_LABEL: Record<InvoiceRow["status"], string> = {
  pending: "待開立",
  issuing: "開立中",
  issued: "已開立",
  failed: "開立失敗",
  voided: "已作廢",
  allowance: "已折讓",
};

export function invoiceSummary(i: InvoiceRow, orderNo?: string) {
  return {
    orderNo,
    status: i.status,
    statusLabel: STATUS_LABEL[i.status],
    invoiceNo: i.invoice_no,
    invoiceDate: i.invoice_date,
    amount: i.amount,
    provider: i.provider,
    attempts: i.attempts,
    error: i.error,
    issuedAt: i.issued_at,
    voidedAt: i.voided_at,
    allowanceNo: i.allowance_no,
    allowanceAmount: i.allowance_amount,
  };
}

/** 依訂單把發票狀態同步到 builder_orders.invoice_status */
async function syncOrder(store: Store, inv: InvoiceRow) {
  await store.setOrderFields(inv.tenant_id, inv.order_id, { invoice_status: inv.status });
}

/* ================================================================== 憑證（只限平台後台） */

export async function saveInvoiceAccount(ctx: ServiceContext, input: { site: string; provider: InvoiceProviderId; sellerTaxId: string; appKey: string }) {
  requireAdminActor(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const taxId = input.sellerTaxId.trim();
  if (!isValidTaxId(taxId)) throw new ServiceError("invalid", "賣方統編不正確（8 碼數字且檢查碼要正確）");
  if (input.provider === "mock" && !tenant.is_test) throw new ServiceError("forbidden", "模擬供應商（mock）只能用在測試租戶（is_test）");
  const key = input.provider === "mock" ? "mock" : input.appKey.trim();
  if (input.provider === "amego" && (key.length < 8 || key.length > 200)) throw new ServiceError("invalid", "App Key 長度不正確");
  await ctx.store.upsertInvoiceAccount({ tenant_id: tenant.id, provider: input.provider, seller_tax_id: taxId, secret_enc: encryptSecret(key, tenant.id) });
  await syncInvoiceModuleStatus(ctx.store, tenant.id);
  await audit(ctx, tenant.id, "invoice_account.save", { provider: input.provider, sellerTaxId: taxId });
  return { saved: true, note: "憑證已加密儲存，請按「驗證」確認可用。" };
}

export async function verifyInvoiceAccount(ctx: ServiceContext, input: { site: string }) {
  requireAdminActor(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const p = await providerFactory(ctx.store, tenant.id);
  if (!p) throw new ServiceError("invalid", "尚未輸入發票憑證");
  const r = await p.verify();
  if (r.ok) await ctx.store.markInvoiceAccount(tenant.id, { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  else await ctx.store.markInvoiceAccount(tenant.id, { status: "unverified", verified_at: null, last_error: r.message.slice(0, 300) });
  await syncInvoiceModuleStatus(ctx.store, tenant.id);
  await audit(ctx, tenant.id, "invoice_account.verify", { ok: r.ok });
  if (!r.ok) throw new ServiceError("invalid", `驗證失敗：${r.message}${amegoRelayFromEnv().relayUrl ? "" : "（尚未設定固定 IP 中繼 AMEGO_RELAY_URL；Amego 會擋浮動 IP）"}`);
  return { verified: true };
}

/** invoice 模組狀態：沒有已驗證的憑證 → pending_setup */
export async function syncInvoiceModuleStatus(store: Store, tenantId: string) {
  const row = (await store.listTenantModules(tenantId)).find((m) => m.module_id === "invoice");
  if (!row || row.status === "disabled") return;
  const acct = await store.getInvoiceAccount(tenantId);
  const want = acct?.status === "verified" ? "enabled" : "pending_setup";
  if (row.status !== want) await store.upsertTenantModule({ ...row, status: want });
}

export async function getInvoiceSetupStatus(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const [acct, states, settings] = await Promise.all([ctx.store.getInvoiceAccount(tenant.id), moduleStates(ctx, tenant.id), publishedInvoiceSettings(ctx.store, tenant)]);
  const relay = amegoRelayFromEnv();
  return {
    invoiceModuleStatus: states.get("invoice")?.status ?? "disabled",
    issueMode: settings.issueMode ?? "manual",
    account: acct ? { configured: true, provider: acct.provider, sellerTaxId: acct.seller_tax_id, status: acct.status, verifiedAt: acct.verified_at, lastError: acct.last_error } : { configured: false },
    relay: { configured: !!relay.relayUrl },
    note: `憑證只能由平台擁有者在後台「電子發票」輸入並驗證；MCP 無法設定或讀出金鑰。${relay.relayUrl ? "" : "⚠️ 尚未設定固定 IP 中繼（AMEGO_RELAY_URL）：Amego 要求白名單 IP，正式開票前必須設定。"}`,
  };
}

/* ================================================================== 開立（claim-then-act） */

export type IssueOutcome = { status: InvoiceRow["status"]; invoice: InvoiceRow; message: string };

/**
 * 為一張已付款訂單開立發票。冪等兩道：
 * 1. DB：builder_invoices.order_id 唯一（重複觸發只會有一列）＋條件式宣告（issuing），併發只有一個打供應商。
 * 2. 供應商：第 2 次以後的嘗試一定先用訂單編號反查（已開過 → 認回不重開）；開立回「OrderId 重複」也是反查認回。
 * 「反查失敗」≠「沒開過」：反查失敗時這次不開，標 failed 待重試。
 */
export async function issueInvoiceForOrder(store: Store, tenant: TenantRow, order: OrderRow, actor: string): Promise<IssueOutcome> {
  if (order.status !== "paid" && order.status !== "fulfilled") throw new ServiceError("invalid", `訂單 ${order.order_no} 尚未付款，不能開立發票`);
  if (order.payment_sandbox) throw new ServiceError("invalid", `訂單 ${order.order_no} 是金流測試環境付款（沒有實際收款），不能開立發票`);
  // 儲值方案是預收款，不是銷售：發票在儲值金實際消費（訂單用儲值金付款）時開
  if (order.items.some((i) => (i as { item_kind?: string }).item_kind === "topup")) throw new ServiceError("invalid", `訂單 ${order.order_no} 是儲值方案（預收款），不開立發票；客人用儲值金消費時的訂單才開立`);
  const amount = invoiceAmount(order);
  const acct = await store.getInvoiceAccount(tenant.id);
  if (!acct) throw new ServiceError("invalid", "尚未設定發票憑證（請平台擁有者到後台「電子發票」輸入）");
  const provider = await providerFactory(store, tenant.id);
  if (!provider) throw new ServiceError("invalid", "尚未設定發票憑證");

  const { row } = await store.ensureInvoice({ tenant_id: tenant.id, order_id: order.id, provider: acct.provider, amount });
  if (row.status === "issued" || row.status === "voided" || row.status === "allowance") {
    return { status: row.status, invoice: row, message: `這張訂單已經有發票（${row.invoice_no}）` };
  }
  const claimed = await store.claimInvoice(tenant.id, row.id, new Date(Date.now() - ISSUING_STALE_MS).toISOString());
  if (!claimed) {
    const cur = (await store.getInvoiceByOrder(tenant.id, order.id)) ?? row;
    return { status: cur.status, invoice: cur, message: cur.status === "issuing" ? "發票正在開立中，請稍後再查" : `發票狀態：${STATUS_LABEL[cur.status]}` };
  }

  const finishIssued = async (r: { invoiceNo: string; randomNumber: string | null; invoiceDate: string; raw: Record<string, unknown> }, via: string) => {
    const done = await store.updateInvoice(tenant.id, claimed.id, ["issuing"], {
      status: "issued",
      invoice_no: r.invoiceNo,
      random_number: r.randomNumber,
      invoice_date: r.invoiceDate,
      raw: r.raw,
      error: null,
      issued_at: new Date().toISOString(),
    });
    const inv = done ?? (await store.getInvoiceByOrder(tenant.id, order.id))!;
    await syncOrder(store, inv);
    await store.insertAudit({ tenant_id: tenant.id, actor, action: "invoice.issue", payload: { orderNo: order.order_no, invoiceNo: r.invoiceNo, via, provider: acct.provider } });
    return { status: inv.status, invoice: inv, message: `已開立發票 ${r.invoiceNo}` };
  };
  const finishFailed = async (message: string, retryable: boolean, raw?: unknown) => {
    const done = await store.updateInvoice(tenant.id, claimed.id, ["issuing"], {
      status: "failed",
      error: `${retryable ? "［可重試］" : "［需人工處理］"}${message}`.slice(0, 500),
      raw: raw ? { last: raw } : claimed.raw,
      // 永久錯誤不再自動重試（人工 retry_invoice 仍可）
      ...(retryable ? {} : { attempts: Math.max(claimed.attempts, MAX_AUTO_ATTEMPTS) }),
    });
    const inv = done ?? claimed;
    await syncOrder(store, inv);
    await store.insertAudit({ tenant_id: tenant.id, actor, action: "invoice.fail", payload: { orderNo: order.order_no, retryable, message: message.slice(0, 200) } });
    return { status: inv.status, invoice: inv, message: `發票開立失敗：${message}` };
  };

  // 第 2 次以後（或卡住被重新宣告）一定先反查
  if (claimed.attempts > 1) {
    const q = await provider.query(order.order_no);
    if (!q.ok) return finishFailed(`反查失敗（無法確認是否已開過，這次不開立）：${q.message}`, true, q.raw);
    if (q.found) return finishIssued(q, "query_recover");
  }

  const items = await store.listOrderItems(tenant.id, order.id);
  const r = await provider.issue({
    orderNo: order.order_no,
    total: amount,
    items: invoiceLines({ items, shipping_fee: order.shipping_fee, discount_total: (order.discount_total ?? 0) + (order.tier_discount ?? 0) + (order.points_discount ?? 0), total: amount }),
    buyerEmail: order.contact.email,
    buyerName: order.contact.name,
    request: order.invoice_request ?? { type: "member" },
  });
  if (r.ok) return finishIssued(r, "issue");
  if ("duplicate" in r && r.duplicate) {
    const q = await provider.query(order.order_no);
    if (q.ok && q.found) return finishIssued(q, "duplicate_recover");
    return finishFailed(`供應商回報訂單已開過發票，但反查不到（${q.ok ? "查無資料" : q.message}）`, true, r.raw);
  }
  return finishFailed(r.message, r.retryable, r.raw);
}

/** 付款成功的副作用：租戶設定為自動開立時才開（失敗不影響付款流程） */
/** 發票金額＝實付（金流／匯款）＋儲值金支付（儲值金是預收款，消費時才算銷售）；點數與等級折扣是折扣 */
export function invoiceAmount(o: Pick<OrderRow, "total" | "wallet_paid">): number {
  return o.total + (o.wallet_paid ?? 0);
}

export async function autoIssueOnPaid(store: Store, tenant: TenantRow, order: OrderRow) {
  try {
    if (order.items.some((i) => (i as { item_kind?: string }).item_kind === "topup")) return null;
    if (!(await invoiceActive(store, tenant.id))) return null;
    const settings = await publishedInvoiceSettings(store, tenant);
    if (settings.issueMode !== "auto_on_paid" || order.payment_sandbox) return null;
    if (!(await store.getInvoiceAccount(tenant.id))) return null;
    return await issueInvoiceForOrder(store, tenant, order, "system:auto_invoice");
  } catch (e) {
    console.error(`[invoice] 自動開立失敗 order=${order.order_no}`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** cron：重試待開立／可重試失敗的發票 */
export async function retryDueInvoices(store: Store, limit = 50) {
  const due = await store.listInvoicesToRetry(limit, MAX_AUTO_ATTEMPTS);
  let issued = 0;
  for (const d of due) {
    const tenant = await store.getTenantById(d.tenant_id);
    if (!tenant) continue;
    const order = await store.getOrderById(tenant.id, d.order_id);
    if (!order) continue;
    try {
      const r = await issueInvoiceForOrder(store, tenant, order, "system:cron");
      if (r.status === "issued") issued++;
    } catch (e) {
      console.error(`[invoice] cron 重試失敗 order=${order.order_no}`, e instanceof Error ? e.message : e);
    }
  }
  return { scanned: due.length, issued };
}

/* ================================================================== 後台＋MCP */

async function findOrder(ctx: ServiceContext, tenant: TenantRow, ref: { orderId?: string; orderNo?: string }) {
  const o = ref.orderId ? await ctx.store.getOrderById(tenant.id, ref.orderId) : ref.orderNo ? await ctx.store.getOrderByNo(tenant.id, ref.orderNo) : null;
  if (!o) throw new ServiceError("not_found", "找不到訂單（請給 orderId 或 orderNo）");
  return o;
}

export async function issueInvoice(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean }) {
  requireScope(ctx, "invoices:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  const existing = await ctx.store.getInvoiceByOrder(tenant.id, o.id);
  if (existing && existing.status !== "pending" && existing.status !== "failed" && existing.status !== "issuing") {
    return { ...invoiceSummary(existing, o.order_no), note: `這張訂單已經有發票（${STATUS_LABEL[existing.status]}），不會重複開立` };
  }
  requireConfirm(input.confirm, `開立電子發票是法律文件，送出後無法撤回（只能作廢或折讓）。訂單 ${o.order_no}，金額 ${twd(invoiceAmount(o))}`);
  const r = await issueInvoiceForOrder(ctx.store, tenant, o, ctx.actor.label);
  return { ...invoiceSummary(r.invoice, o.order_no), note: r.message };
}

export async function retryInvoice(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean }) {
  requireScope(ctx, "invoices:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  const existing = await ctx.store.getInvoiceByOrder(tenant.id, o.id);
  if (!existing) throw new ServiceError("not_found", `訂單 ${o.order_no} 還沒有發票紀錄，請用 issue_invoice`);
  if (existing.status !== "failed" && existing.status !== "pending" && existing.status !== "issuing") throw new ServiceError("conflict", `發票狀態為「${STATUS_LABEL[existing.status]}」，不需要重試`);
  requireConfirm(input.confirm, `重試開立訂單 ${o.order_no} 的發票（會先向供應商反查，已開過就認回不重開）`);
  const r = await issueInvoiceForOrder(ctx.store, tenant, o, ctx.actor.label);
  return { ...invoiceSummary(r.invoice, o.order_no), note: r.message };
}

/**
 * 作廢或折讓：同一期（雙月）內 → 作廢（f0501）；跨期 → 開折讓單（g0401，預設全額，可指定 allowanceAmount）。
 */
export async function voidInvoice(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean; reason?: string; allowanceAmount?: number }) {
  requireScope(ctx, "invoices:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  const inv = await ctx.store.getInvoiceByOrder(tenant.id, o.id);
  if (!inv || inv.status !== "issued" || !inv.invoice_no) throw new ServiceError("invalid", `訂單 ${o.order_no} 沒有可作廢的已開立發票（目前：${inv ? STATUS_LABEL[inv.status] : "無"}）`);
  const sameperiod = canVoidInPeriod(inv.invoice_date ?? "");
  const amount = input.allowanceAmount ?? inv.amount;
  if (!sameperiod && (!Number.isInteger(amount) || amount <= 0 || amount > inv.amount)) throw new ServiceError("invalid", `折讓金額需為 1–${inv.amount} 的整數`);
  requireConfirm(
    input.confirm,
    sameperiod
      ? `作廢發票 ${inv.invoice_no}（訂單 ${o.order_no}，${twd(inv.amount)}）會通知財政部，無法復原`
      : `發票 ${inv.invoice_no} 已跨期（開立於 ${inv.invoice_date}），不能作廢，會改開折讓單 ${twd(amount)}，無法復原`,
  );
  const provider = await providerFactory(ctx.store, tenant.id);
  if (!provider) throw new ServiceError("invalid", "尚未設定發票憑證");
  const reason = input.reason?.trim().slice(0, 20) || "訂單取消";
  if (sameperiod) {
    const r = await provider.void({ invoiceNo: inv.invoice_no, reason });
    if (!r.ok) throw new ServiceError("invalid", `作廢失敗${r.retryable ? "（暫時性錯誤，可稍後重試）" : ""}：${r.message}`);
    const done = (await ctx.store.updateInvoice(tenant.id, inv.id, ["issued"], { status: "voided", voided_at: new Date().toISOString(), raw: { ...(inv.raw ?? {}), void: r.raw } }))!;
    await syncOrder(ctx.store, done);
    await audit(ctx, tenant.id, "invoice.void", { orderNo: o.order_no, invoiceNo: inv.invoice_no });
    return { ...invoiceSummary(done, o.order_no), action: "void", note: `發票 ${inv.invoice_no} 已作廢` };
  }
  const allowanceNo = `AL${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`.slice(0, 16);
  const req = o.invoice_request;
  const r = await provider.allowance({
    allowanceNo,
    invoiceNo: inv.invoice_no,
    invoiceDate: inv.invoice_date ?? "",
    amount,
    buyerEmail: o.contact.email,
    buyerName: req?.type === "b2b" ? req.title : o.contact.name,
    buyerTaxId: req?.type === "b2b" ? req.taxId : null,
    description: `訂單 ${o.order_no} ${reason}`,
  });
  if (!r.ok) throw new ServiceError("invalid", `折讓失敗${r.retryable ? "（暫時性錯誤，可稍後重試）" : ""}：${r.message}`);
  const done = (await ctx.store.updateInvoice(tenant.id, inv.id, ["issued"], { status: "allowance", allowance_no: allowanceNo, allowance_amount: amount, raw: { ...(inv.raw ?? {}), allowance: r.raw } }))!;
  await syncOrder(ctx.store, done);
  await audit(ctx, tenant.id, "invoice.allowance", { orderNo: o.order_no, invoiceNo: inv.invoice_no, allowanceNo, amount });
  return { ...invoiceSummary(done, o.order_no), action: "allowance", note: `發票已跨期，已開立折讓單 ${allowanceNo}（${twd(amount)}）` };
}

export async function getInvoice(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const o = await findOrder(ctx, tenant, input);
  const inv = await ctx.store.getInvoiceByOrder(tenant.id, o.id);
  return inv
    ? { ...invoiceSummary(inv, o.order_no), canVoid: inv.status === "issued" && canVoidInPeriod(inv.invoice_date ?? ""), request: o.invoice_request }
    : { orderNo: o.order_no, status: null, canVoid: false, note: "尚未開立", request: o.invoice_request };
}

export async function listInvoices(ctx: ServiceContext, input: { site?: string | null; status?: InvoiceRow["status"]; limit?: number; offset?: number }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireInvoice(ctx, tenant);
  const r = await ctx.store.listInvoices(tenant.id, { status: input.status, limit: Math.max(1, Math.min(100, input.limit ?? 20)), offset: Math.max(0, input.offset ?? 0) });
  const orders = await Promise.all(r.rows.map((i) => ctx.store.getOrderById(tenant.id, i.order_id)));
  return { total: r.total, invoices: r.rows.map((i, k) => invoiceSummary(i, orders[k]?.order_no)) };
}

export { invoiceSettings };
