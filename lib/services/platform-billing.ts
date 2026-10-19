import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { logUnsentMail } from "../mail";
import { z } from "zod";
import type { Mailer } from "../mail";
import type { GeminiFn } from "../ai/gemini";
import { newSectionId, createSite } from "./sites";
import { getModule, validateSectionProps } from "@/modules/registry";
import { adjustModuleStatus } from "../shop/status";
import { adminActor } from "../tokens";
import { THEME_PRESETS } from "../themes";
import { classifyPchomepayQuery, genGatewayOrderNo } from "../pay/pchomepay";
import { platformPayClient, platformPayConfig } from "../platform/payment";
import { quoteBuild, QuoteError, BASE_MODULES, type BuildQuote } from "../platform/pricing";
import { RESERVED_SUBDOMAINS } from "../host-routing";
import { siteBase } from "../site-url";
import { siteSlug } from "../validators";
import type { SiteContent } from "../content";
import type { PlatformOrderRow, Store, TenantRow } from "../store/types";
import { ServiceError, audit, resolveTenant, type ServiceContext } from "./context";
import { inviteOwnerInternal, requireTeamAdmin } from "./owners";

/**
 * 平台收費（第九批）：/build 組裝器 → 平台訂單 builder_platform_orders → 平台自己的 PChomePay 帳號付款 →
 * 🔴 權威回查確認付款（notify 沒有簽章，只取 order_id 當查詢鍵）→ 冪等開站／加購開通／續費。
 *
 * 安全規則（沿用租戶金流）：
 * 1. 價格只由 server 算（lib/platform/pricing.ts）；前端送的金額一律不採信。
 * 2. notify：只取 order_id → 一律用平台憑證 GET /v1/payment/{order_id} 回查，回查環境必須等於建單環境；權威欄位 status（S／F／P）。
 * 3. 權威金額＝訂單金額才標記；條件式 pending_payment|expired → paid 只成功一次。
 * 4. 開站：claimPlatformProvision 條件式宣告（同時只有一個在跑）；builder_tenants.platform_order_id unique＝一張單只開一個站；每一步都冪等，失敗可重試。
 * 5. 逾期前先回查：已付 → 照常開站；處理中／失敗 → 才標 expired；回查失敗 → 這次不動。
 * 6. sandbox（測試金鑰）只限本機或帶平台測試簽章；sandbox 訂單一律開 is_test 網站。
 *
 * 月費：PChomePay 沒有定期定額扣款 → 第一版「每月寄帳單連結」：第一次付款＝建置費＋第一個月；
 * 每期到期前 7 天 cron 建續費單並寄付款連結給店主；逾期進寬限 7 天（past_due）→ 停站（tenant suspended，不刪資料）→ 付款後恢復。
 */
export const PENDING_TTL_MS = 2 * 3600_000;
export const PROVISION_STALE_MS = 10 * 60_000;
export const RENEWAL_LEAD_MS = 7 * 86400_000;
export const GRACE_MS = 7 * 86400_000;
const MONTH_MS = 30 * 86400_000;

export interface PlatformDeps {
  store: Store;
  /** 平台網址 */
  baseUrl: string;
  previewSecret: string;
  sendMail?: Mailer;
  /** 測試注入：PChomePay 的 fetch */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** 首頁草稿用的 AI；null＝用模板文字 */
  gemini?: GeminiFn | null;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const notifyEmail = () => process.env.PLATFORM_NOTIFY_EMAIL?.trim() || "gathertaiwan@gmail.com";

function taipeiDay(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}
function newOrderNo() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let r = "";
  for (const b of randomBytes(6)) r += A[b % A.length];
  return `GP-${taipeiDay()}-${r}`;
}

async function mail(deps: { sendMail?: Mailer }, to: string, subject: string, text: string) {
  if (!deps.sendMail) {
    logUnsentMail("platform-billing", to, subject, text);
    return;
  }
  try {
    await deps.sendMail(to, subject, text);
  } catch (e) {
    console.error("[platform-billing] 寄信失敗", e instanceof Error ? e.message : e);
  }
}

export function orderStatusUrl(baseUrl: string, orderNo: string, accessKey: string) {
  return `${baseUrl.replace(/\/$/, "")}/build/orders/${encodeURIComponent(orderNo)}?k=${encodeURIComponent(accessKey)}`;
}

export function checkAccessKey(order: Pick<PlatformOrderRow, "access_key_hash">, key: unknown): boolean {
  if (typeof key !== "string" || key.length < 20 || key.length > 100) return false;
  const a = Buffer.from(sha256(key));
  const b = Buffer.from(order.access_key_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 平台測試簽章（後台產生，1 小時）：在正式站用 sandbox 金鑰測試 /build 結帳時要帶 */
export function buildTestToken(secret: string, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + 3600;
  return `${exp}.${createHash("sha256").update(`${secret}:buildtest:${exp}`).digest("base64url")}`;
}
export function verifyBuildTestToken(secret: string, token: unknown, nowMs = Date.now()) {
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) * 1000 < nowMs) return false;
  const want = Buffer.from(createHash("sha256").update(`${secret}:buildtest:${exp}`).digest("base64url"));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/* ================================================================== 報價、網址代號 */

export function getBuildQuote(input: { modules: unknown; existing?: string[]; existingMonthly?: number }): BuildQuote {
  const mods = Array.isArray(input.modules) ? input.modules.map(String) : [];
  try {
    return quoteBuild(mods, { existing: input.existing, existingMonthly: input.existingMonthly });
  } catch (e) {
    if (e instanceof QuoteError) throw new ServiceError("invalid", e.message);
    throw e;
  }
}

export async function slugAvailability(store: Store, raw: unknown): Promise<{ slug: string; available: boolean; reason?: string }> {
  const p = siteSlug.safeParse(typeof raw === "string" ? raw.trim().toLowerCase() : "");
  const slug = typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 40) : "";
  if (!p.success) return { slug, available: false, reason: "網址代號 3–40 字，只能用小寫英文、數字與 -（不能以 - 開頭或結尾）" };
  if (RESERVED_SUBDOMAINS.has(p.data)) return { slug: p.data, available: false, reason: "這個代號保留給平台使用" };
  if (await store.getTenantBySlug(p.data)) return { slug: p.data, available: false, reason: "這個代號已被使用" };
  const live = (await store.listPlatformOrders({ status: ["pending_payment", "paid"], kind: "new_site", limit: 200 })).find((o) => o.slug === p.data && !(o.status === "pending_payment" && Date.parse(o.expires_at) <= Date.now()));
  if (live) return { slug: p.data, available: false, reason: "這個代號正在被其他訂單使用（未付款的訂單 2 小時後釋放）" };
  return { slug: p.data, available: true };
}

/* ================================================================== 建單 */

/** 同一個代號的待付款單已過期 → 先處理掉（有付款紀錄的先權威回查，已付就照常開站），讓代號釋放 */
async function releaseStaleSlug(deps: PlatformDeps, rawSlug: string) {
  const slug = rawSlug.trim().toLowerCase();
  const stale = (await deps.store.listPlatformOrders({ status: ["pending_payment"], kind: "new_site", limit: 200 })).filter((o) => o.slug === slug && Date.parse(o.expires_at) <= Date.now());
  for (const o of stale) {
    if (o.gateway_order_no) {
      const r = await settleFromQuery(deps, o);
      // 第九批審查 M2：回查是處理中（P，客人可能正在付款）也不釋放代號
      if (r === "paid" || r === "already_paid" || r === "query_failed" || r === "unknown" || r === "missing_amount" || r === "pending" || r === "paid_needs_attention") continue;
    }
    await deps.store.updatePlatformOrder(o.id, { status: "expired" }, { status: ["pending_payment"] });
  }
}

export const buildOrderInput = z
  .object({
    modules: z.array(z.string().trim().min(1).max(40)).max(40),
    themePreset: z.enum(THEME_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(),
    brandName: z.string().trim().min(1, "請填品牌名稱").max(120),
    slug: z.string().trim().toLowerCase(),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Email 格式不正確" })),
  })
  .strict();

/**
 * 開站訂單：server 重算價格（輸入是 strict，多送 price／total 直接拒絕）→ 網址代號檢查 → 建單（pending_payment，2 小時）。
 * 平台金流沒設定 → 拒絕（「尚未開放付款」）。sandbox 金鑰 → 只在 allowSandbox（本機或測試簽章）時可以，且一律 is_test。
 */
export async function createBuildOrder(deps: PlatformDeps, input: unknown, opts: { by: string; allowSandbox: boolean }) {
  const r = buildOrderInput.safeParse(input);
  if (!r.success) throw new ServiceError("invalid", r.error.issues.map((i) => `${i.path.join(".") || "輸入"}：${i.message}`).join("；"));
  const d = r.data;
  const cfg = platformPayConfig();
  if (!cfg) throw new ServiceError("invalid", "平台尚未開放線上付款（老闆還沒設定平台金流帳號），目前只能試算價格");
  if (cfg.sandbox && !opts.allowSandbox) throw new ServiceError("forbidden", "平台金流目前是測試環境，只開放內部測試");
  await releaseStaleSlug(deps, d.slug);
  const slug = await slugAvailability(deps.store, d.slug);
  if (!slug.available) throw new ServiceError("conflict", `網址代號「${slug.slug}」不能用：${slug.reason}`);
  const q = getBuildQuote({ modules: d.modules });
  const accessKey = randomBytes(24).toString("base64url");
  let order: PlatformOrderRow;
  try {
    order = await deps.store.insertPlatformOrder({
      order_no: newOrderNo(),
      kind: "new_site",
      tenant_id: null,
      slug: slug.slug,
      brand_name: d.brandName,
      theme_preset: d.themePreset ?? null,
      contact_email: d.email,
      modules: q.lines.map((l) => l.id),
      amount_setup: q.setupTotal,
      amount_monthly: q.monthlyTotal,
      amount_total: q.firstPayment,
      period_start: null,
      period_end: null,
      sandbox: cfg.sandbox,
      is_test: cfg.sandbox,
      access_key_hash: sha256(accessKey),
      expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
      created_by: opts.by,
    });
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") throw new ServiceError("conflict", `網址代號「${slug.slug}」剛被其他訂單使用，請換一個`);
    throw e;
  }
  await deps.store.insertAudit({ tenant_id: null, actor: opts.by, action: "platform_order.create", payload: { orderNo: order.order_no, kind: "new_site", slug: slug.slug, total: q.firstPayment, sandbox: cfg.sandbox } });
  return { order, accessKey, quote: q, statusUrl: orderStatusUrl(deps.baseUrl, order.order_no, accessKey) };
}

/** 加購模組（店主後台 owner 角色、平台後台、MCP 平台／網站 token）：只算租戶還沒有的模組；付款後自動開通 */
export async function createAddonOrder(ctx: ServiceContext, input: { site?: string | null; modules: string[] }, deps: Omit<PlatformDeps, "store" | "baseUrl" | "previewSecret"> & { allowSandbox?: boolean } = {}) {
  if (ctx.actor.kind === "owner") requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const billing = await ctx.store.getTenantBilling(tenant.id);
  if (!billing) throw new ServiceError("invalid", "這個網站不是經 /build 開立的，請聯絡平台處理加購");
  const cfg = platformPayConfig();
  if (!cfg) throw new ServiceError("invalid", "平台尚未開放線上付款");
  if (cfg.sandbox && !(deps.allowSandbox || tenant.is_test)) throw new ServiceError("forbidden", "平台金流目前是測試環境，只開放測試網站");
  const enabled = (await ctx.store.listTenantModules(tenant.id)).filter((m) => m.status !== "disabled").map((m) => m.module_id);
  const owned = [...new Set([...billing.modules, ...enabled])];
  const q = getBuildQuote({ modules: input.modules, existing: owned, existingMonthly: billing.monthly_amount });
  if (!q.lines.length) throw new ServiceError("invalid", "選的模組都已經開通了");
  // 第九批審查 L11：已有含重疊模組、還沒逾期的待付款加購單 → 拒絕（請先付款或等它逾期），避免重複收費
  const pendingAddons = (await ctx.store.listPlatformOrders({ tenantId: tenant.id, kind: "add_modules", status: ["pending_payment"], limit: 20 })).filter((o) => Date.parse(o.expires_at) > Date.now());
  const overlap = pendingAddons.find((o) => o.modules.some((m) => q.lines.some((l) => l.id === m)));
  if (overlap) throw new ServiceError("conflict", `已有包含 ${overlap.modules.filter((m) => q.lines.some((l) => l.id === m)).join("、")} 的待付款加購單 ${overlap.order_no}，請先完成付款（或等 2 小時後逾期）再加購`);
  const accessKey = randomBytes(24).toString("base64url");
  const order = await ctx.store.insertPlatformOrder({
    order_no: newOrderNo(),
    kind: "add_modules",
    tenant_id: tenant.id,
    slug: null,
    brand_name: tenant.name,
    theme_preset: null,
    contact_email: await ownerContact(ctx.store, tenant),
    modules: q.lines.map((l) => l.id),
    amount_setup: q.setupTotal,
    amount_monthly: q.monthlyTotal,
    amount_total: q.firstPayment,
    period_start: null,
    period_end: null,
    sandbox: cfg.sandbox,
    is_test: tenant.is_test || cfg.sandbox,
    access_key_hash: sha256(accessKey),
    expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    created_by: ctx.actor.label,
  });
  await audit(ctx, tenant.id, "platform_order.create", { orderNo: order.order_no, kind: "add_modules", modules: order.modules, total: order.amount_total });
  return { orderNo: order.order_no, accessKey, quote: q, statusUrl: orderStatusUrl(ctx.baseUrl, order.order_no, accessKey) };
}

async function ownerContact(store: Store, tenant: TenantRow): Promise<string> {
  for (const m of await store.listTenantUsers(tenant.id)) {
    if (m.role === "owner" && m.status === "active") {
      const u = await store.getOwnerUserById(m.user_id);
      if (u) return u.email;
    }
  }
  const po = tenant.platform_order_id ? await store.getPlatformOrderById(tenant.platform_order_id) : null;
  return po?.contact_email ?? notifyEmail();
}

/* ================================================================== 付款（人點連結才付；agent 不能代付） */

/** 付款頁「前往付款」：用平台帳號建 PChomePay 付款（同一張單重按沿用同一筆）→ 回傳付款網址 */
export async function startPlatformCheckout(deps: PlatformDeps, input: { orderNo: string; accessKey: unknown }) {
  const order = await deps.store.getPlatformOrderByNo(input.orderNo);
  if (!order || !checkAccessKey(order, input.accessKey)) throw new ServiceError("not_found", "找不到這張訂單");
  if (order.status !== "pending_payment") throw new ServiceError("conflict", order.status === "paid" ? "這張訂單已付款" : "這張訂單已逾期，請重新下單");
  if (Date.parse(order.expires_at) <= Date.now()) throw new ServiceError("conflict", "這張訂單已逾期，請重新下單");
  if (order.payment_url && order.gateway_order_no) return { paymentUrl: order.payment_url, reused: true };
  const client = platformPayClient(order.sandbox, deps.fetchImpl);
  if (!client) throw new ServiceError("invalid", "平台尚未開放線上付款（或金流環境已變更），請聯絡我們");
  const gw = `GP${genGatewayOrderNo().slice(2)}`;
  const claimed = await deps.store.updatePlatformOrder(order.id, { gateway_order_no: gw }, { status: ["pending_payment"], gatewayIsNull: true });
  if (!claimed) {
    const cur = await deps.store.getPlatformOrderById(order.id);
    if (cur?.payment_url) return { paymentUrl: cur.payment_url, reused: true };
    throw new ServiceError("conflict", "付款建立中，請稍後重新整理");
  }
  const back = orderStatusUrl(deps.baseUrl, order.order_no, String(input.accessKey));
  const p = await client.createPayment({
    orderNo: gw,
    amount: order.amount_total,
    itemName: order.kind === "new_site" ? `Gather Builder 建站：${order.brand_name ?? order.slug}` : order.kind === "renewal" ? `Gather Builder 月費：${order.brand_name ?? ""}` : `Gather Builder 加購模組：${order.brand_name ?? ""}`,
    itemUrl: `${deps.baseUrl.replace(/\/$/, "")}/build`,
    returnUrl: back,
    notifyUrl: `${deps.baseUrl.replace(/\/$/, "")}/api/platform/pay/notify`,
    buyerEmail: order.contact_email,
    holdHours: 1,
  });
  if (!p) {
    // 建單失敗：放掉閘道單號讓客人可以重試
    await deps.store.updatePlatformOrder(order.id, { gateway_order_no: null }, { status: ["pending_payment"] });
    throw new ServiceError("invalid", "金流暫時無法建立付款，請稍後再試");
  }
  await deps.store.updatePlatformOrder(order.id, { payment_url: p.paymentUrl });
  await deps.store.insertAudit({ tenant_id: order.tenant_id, actor: "platform", action: "platform_order.checkout", payload: { orderNo: order.order_no, gateway: gw, sandbox: order.sandbox } });
  return { paymentUrl: p.paymentUrl, reused: false };
}

/* ================================================================== notify／權威回查／開站 */

export type PlatformNotifyResult = { status: number; body: string; outcome: string };

/** PChomePay notify（平台帳號）：沒有簽章 → 只取 order_id 當查詢鍵，一律權威回查 */
export async function handlePlatformNotify(deps: PlatformDeps, rawBody: string): Promise<PlatformNotifyResult> {
  const ok = (outcome: string) => ({ status: 200, body: "success", outcome });
  const retry = (outcome: string) => ({ status: 500, body: "retry", outcome });
  const sp = new URLSearchParams(rawBody);
  let gw = "";
  try {
    gw = String((JSON.parse(sp.get("notify_message") ?? "") as Record<string, unknown>)?.order_id ?? "").trim();
  } catch {
    /* 下方處理 */
  }
  if (!/^[A-Za-z0-9]{1,20}$/.test(gw)) return ok("missing_order_id");
  const order = await deps.store.getPlatformOrderByGatewayNo(gw);
  if (!order) return ok("unknown_order");
  const r = await settleFromQuery(deps, order);
  return r === "query_failed" || r === "unknown" || r === "missing_amount" || r === "provision_failed" ? retry(r) : ok(r);
}

/** 權威回查 → 依結果標記（notify、逾期 sweep、付款頁重新整理共用） */
export async function settleFromQuery(deps: PlatformDeps, orderIn: PlatformOrderRow): Promise<string> {
  const order = (await deps.store.getPlatformOrderById(orderIn.id)) ?? orderIn;
  if (!order.gateway_order_no) return "no_payment";
  if (order.status === "paid_needs_attention") return "already_paid";
  if (order.status === "paid") {
    if (order.provision_state !== "done") await provisionPlatformOrder(deps, order.id);
    return "already_paid";
  }
  const client = platformPayClient(order.sandbox, deps.fetchImpl);
  if (!client) return "query_failed";
  const q = await client.queryPayment(order.gateway_order_no);
  if (!q) {
    await deps.store.updatePlatformOrder(order.id, { query_failures: order.query_failures + 1 });
    return "query_failed";
  }
  const st = classifyPchomepayQuery(q);
  if (st === "unknown") return "unknown";
  if (st !== "paid") return st;
  if (q.amount == null) return "missing_amount";
  if (Math.round(q.amount) !== order.amount_total) {
    console.error(`[platform-billing] 🔴 金額不符 order=${order.order_no} 回查=${q.amount} 訂單=${order.amount_total}`);
    await alertPlatform(deps, order, `PChomePay 回查金額 ${q.amount} 與訂單金額 ${order.amount_total} 不符，未標記付款`);
    return "amount_mismatch";
  }
  // 條件式轉換：只有真正轉換成功的那一次往下開站（逾期後才付款也接受，網址被占用時開站失敗並警示）
  let moved: PlatformOrderRow | null;
  try {
    moved = await deps.store.updatePlatformOrder(order.id, { status: "paid", paid_at: new Date().toISOString(), paid_amount: Math.round(q.amount) }, { status: ["pending_payment", "expired"] });
  } catch (e) {
    // 第九批審查 M2：逾期後才付款、代號已被另一張進行中的單占用（live_slug 唯一索引）→ 不丟錯（避免無限重送）：
    // 標 paid_needs_attention（已收款）、立即警示平台、寄信告訴付款人會人工處理
    if (!(e instanceof ServiceError && e.code === "conflict")) throw e;
    return markNeedsAttention(deps, order, Math.round(q.amount), "逾期後才付款，網址代號已被另一張訂單使用，無法自動開站");
  }
  if (!moved) return "already_paid";
  await deps.store.insertAudit({ tenant_id: order.tenant_id, actor: "pchomepay:platform", action: "platform_order.paid", payload: { orderNo: order.order_no, amount: q.amount, sandbox: order.sandbox, wasExpired: order.status === "expired" } });
  const p = await provisionPlatformOrder(deps, order.id);
  if (p.attention) return "paid_needs_attention";
  return p.ok ? "paid" : "provision_failed";
}

/** 已收款但無法自動開站：paid_needs_attention＋警示平台（一次）＋寄信給付款人（回 notify 成功，不讓金流無限重送） */
async function markNeedsAttention(deps: PlatformDeps, order: PlatformOrderRow, paidAmount: number | null, reason: string): Promise<string> {
  const moved = await deps.store.updatePlatformOrder(order.id, { status: "paid_needs_attention", ...(paidAmount !== null ? { paid_at: new Date().toISOString(), paid_amount: paidAmount } : {}), provision_error: reason.slice(0, 300) }, { status: ["pending_payment", "expired", "paid"] });
  if (!moved) return "already_paid";
  await deps.store.insertAudit({ tenant_id: order.tenant_id, actor: "pchomepay:platform", action: "platform_order.paid_needs_attention", payload: { orderNo: order.order_no, reason } });
  await alertPlatform(deps, moved, `🔴 已收款但無法自動開站：${reason}。請聯絡客人改網址代號後人工開站，或到 PChomePay 後台退款。`);
  await mail(deps, order.contact_email, `【Gather Builder】已收到你的付款（訂單 ${order.order_no}）`, `你好，\n\n我們已收到你的付款 ${twd(paidAmount ?? order.amount_total)}（訂單 ${order.order_no}），但${reason.includes("代號") ? `你選的網址代號「${order.slug}」已被使用` : "系統無法自動建立網站"}。\n我們會在 1 個工作天內與你聯絡，協助更換網址代號後開站，或全額退款。不需要再付款。`);
  return "paid_needs_attention";
}

async function alertPlatform(deps: PlatformDeps, order: PlatformOrderRow, reason: string) {
  // 每張單只警示一次
  if (!(await deps.store.updatePlatformOrder(order.id, { alerted_at: new Date().toISOString() }, { alertedIsNull: true }))) return;
  await mail(deps, notifyEmail(), `⚠️【Gather Builder】平台訂單需要處理 ${order.order_no}`, `${reason}\n訂單：${order.order_no}（${order.kind}，${twd(order.amount_total)}${order.sandbox ? "，測試環境" : ""}）`);
}

/**
 * 開站／加購開通／續費（冪等、可重試）：先條件式宣告，同時只有一個在跑；每一步都可重跑。
 * 失敗 → provision_state=failed＋錯誤（cron 與付款頁重新整理會重試；第 3 次起警示平台）。
 */
export async function provisionPlatformOrder(deps: PlatformDeps, orderId: string): Promise<{ ok: boolean; tenant?: TenantRow; error?: string; attention?: boolean }> {
  const claimed = await deps.store.claimPlatformProvision(orderId, new Date(Date.now() - PROVISION_STALE_MS).toISOString());
  if (!claimed) {
    // 沒宣告到：已完成，或另一個 notify／cron 正在開（併發）→ 都不算失敗（整合測試抓到：併發時誤報 provision_failed）
    const cur = await deps.store.getPlatformOrderById(orderId);
    return { ok: cur?.provision_state === "done" || cur?.provision_state === "provisioning", tenant: cur?.tenant_id ? ((await deps.store.getTenantById(cur.tenant_id)) ?? undefined) : undefined };
  }
  try {
    const tenant = claimed.kind === "new_site" ? await provisionNewSite(deps, claimed) : claimed.kind === "add_modules" ? await provisionAddon(deps, claimed) : await provisionRenewal(deps, claimed);
    await deps.store.updatePlatformOrder(claimed.id, { provision_state: "done", provisioned_at: new Date().toISOString(), provision_error: null, tenant_id: tenant.id }, { provision_state: ["provisioning"] });
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:provision", action: `platform_order.provisioned`, payload: { orderNo: claimed.order_no, kind: claimed.kind, attempts: claimed.provision_attempts } });
    return { ok: true, tenant };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    console.error(`[platform-billing] 開站失敗 order=${claimed.order_no} 第 ${claimed.provision_attempts} 次`, msg);
    await deps.store.updatePlatformOrder(claimed.id, { provision_state: "failed", provision_error: msg }, { provision_state: ["provisioning"] });
    if (e instanceof SlugTakenError) {
      // 第九批審查 M2：代號被占用 → 重試也不會成功：轉 paid_needs_attention、通知平台與付款人
      await markNeedsAttention(deps, claimed, null, msg);
      return { ok: false, error: msg, attention: true };
    }
    if (claimed.provision_attempts >= 3) await alertPlatform(deps, claimed, `付款成功但開站／開通失敗（第 ${claimed.provision_attempts} 次）：${msg}`);
    return { ok: false, error: msg };
  }
}

class SlugTakenError extends Error {}

/** 已購模組集合的月費（模組註冊表 priceMonthly 合計） */
export function monthlyFor(moduleIds: string[]): number {
  return [...new Set(moduleIds)].reduce((a, id) => a + (getModule(id)?.priceMonthly ?? 0), 0);
}

function systemCtx(deps: PlatformDeps): ServiceContext {
  return { actor: { ...adminActor(), label: "system:provision" }, store: deps.store, baseUrl: deps.baseUrl, previewSecret: deps.previewSecret, sendMail: deps.sendMail };
}

async function provisionNewSite(deps: PlatformDeps, order: PlatformOrderRow): Promise<TenantRow> {
  let tenant = await deps.store.getTenantByPlatformOrder(order.id);
  if (!tenant) {
    const copy = await homepageCopy(deps.gemini ?? null, order);
    try {
      await createSite(
        systemCtx(deps),
        { slug: order.slug!, name: order.brand_name ?? order.slug!, modules: order.modules.filter((m) => m !== "core"), themePreset: order.theme_preset ?? undefined, test: order.is_test },
        { platformOrderId: order.id, issueToken: false, content: (c) => homepageContent(c, order, copy) },
      );
    } catch (e) {
      // 併發或重試：同一張單已經開過（platform_order_id unique）→ 沿用；否則是網址被別人用掉
      tenant = await deps.store.getTenantByPlatformOrder(order.id);
      if (!tenant) {
        if (e instanceof ServiceError && e.code === "conflict") throw new SlugTakenError(`網址代號「${order.slug}」已被使用，無法開站（需人工改代號或退款）`);
        throw e instanceof Error ? e : new Error(String(e));
      }
    }
    tenant = tenant ?? (await deps.store.getTenantByPlatformOrder(order.id));
    if (!tenant) throw new Error("開站後找不到網站");
  }
  const paidAt = order.paid_at ? Date.parse(order.paid_at) : Date.now();
  await deps.store.insertTenantBilling({ tenant_id: tenant.id, modules: order.modules, monthly_amount: order.amount_monthly, paid_until: new Date(paidAt + MONTH_MS).toISOString(), is_test: order.is_test });
  if (order.tenant_id !== tenant.id) await deps.store.updatePlatformOrder(order.id, { tenant_id: tenant.id });
  // 店主帳號：沒有成員資格才邀請（重試不重複寄）
  const user = await deps.store.getOwnerUserByEmail(order.contact_email);
  const member = user ? await deps.store.getTenantUser(tenant.id, user.id) : null;
  if (!member) {
    await inviteOwnerInternal({ store: deps.store, ipSecret: deps.previewSecret, baseUrl: deps.baseUrl, sendMail: deps.sendMail }, tenant, { email: order.contact_email, role: "owner", by: "system:provision" });
    const base = deps.baseUrl.replace(/\/$/, "");
    await mail(
      deps,
      order.contact_email,
      `【Gather Builder】你的網站「${tenant.name}」已開好`,
      `你好，\n\n付款已確認（訂單 ${order.order_no}，${twd(order.amount_total)}），網站已自動建立：\n網址：${siteBase(tenant, deps.baseUrl)}\n店主後台：${base}/owner/t/${tenant.slug}\n\n首頁已依你的品牌產生草稿，請到店主後台「內容編輯」調整後按「發布」上線。\n另一封信是設定店主密碼的邀請連結（7 天內有效）。\n\n想讓 AI agent（Claude 等）幫你管理網站：在店主後台「MCP 連線」可以用 OAuth 直接連線，或發行一組 token。`,
    );
  }
  return tenant;
}

async function provisionAddon(deps: PlatformDeps, order: PlatformOrderRow): Promise<TenantRow> {
  const tenant = order.tenant_id ? await deps.store.getTenantById(order.tenant_id) : null;
  if (!tenant) throw new Error("找不到要加購的網站");
  const states = new Map((await deps.store.listTenantModules(tenant.id)).map((m) => [m.module_id, m]));
  const now = new Date().toISOString();
  for (const id of order.modules) {
    const cur = states.get(id);
    if (cur && cur.status !== "disabled") continue;
    const m = getModule(id);
    if (!m) continue;
    const status = await adjustModuleStatus(deps.store, tenant.id, id, m.settingsSchema.safeParse({}).success ? "enabled" : "pending_setup");
    await deps.store.upsertTenantModule({ tenant_id: tenant.id, module_id: id, status, config: {}, enabled_at: now });
  }
  // 第九批審查 L11：月費以「已購買的模組集合」重算（不累加；重試、重疊都不會重複計費）
  const b = await deps.store.getTenantBilling(tenant.id);
  if (b) {
    const purchased = [...new Set([...b.modules, ...order.modules])];
    await deps.store.updateTenantBilling(tenant.id, { modules: purchased, monthly_amount: monthlyFor(purchased) });
  }
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:provision", action: "module.enable_paid", payload: { orderNo: order.order_no, modules: order.modules } });
  return tenant;
}

async function provisionRenewal(deps: PlatformDeps, order: PlatformOrderRow): Promise<TenantRow> {
  const tenant = order.tenant_id ? await deps.store.getTenantById(order.tenant_id) : null;
  if (!tenant) throw new Error("找不到要續費的網站");
  const b = await deps.store.getTenantBilling(tenant.id);
  if (!b) throw new Error("找不到月費資料");
  // 冪等：paid_until 已經涵蓋這一期就不再延長
  if (order.period_end && Date.parse(b.paid_until) < Date.parse(order.period_end)) {
    await deps.store.updateTenantBilling(tenant.id, { paid_until: order.period_end, status: b.status === "cancelled" ? "cancelled" : "active", grace_until: null, suspended_at: null });
  }
  if (b.status === "suspended" && tenant.status === "suspended") {
    await deps.store.updateTenant(tenant.id, { status: "active" });
    await deps.store.updateTenantBilling(tenant.id, { status: "active" });
  }
  return tenant;
}

/* ================================================================== AI／模板首頁草稿 */

interface HomeCopy {
  tagline: string;
  about: string;
  features: { title: string; body: string; icon?: string }[];
}

const MODULE_FEATURE: Record<string, { title: string; body: string; icon: string }> = {
  shop: { title: "線上商店", body: "直接在網站上選購商品、線上付款。", icon: "🛍️" },
  booking: { title: "線上預約", body: "選好時段就能預約，不用來回訊息。", icon: "📅" },
  events: { title: "活動報名", body: "最新活動與課程，線上報名。", icon: "🎟️" },
  courses: { title: "線上課程", body: "隨時隨地學習，進度自動記錄。", icon: "🎓" },
  blog: { title: "最新消息", body: "分享品牌故事與最新動態。", icon: "📰" },
  members: { title: "會員專區", body: "加入會員，查詢訂單與專屬優惠。", icon: "👤" },
};

async function homepageCopy(gemini: GeminiFn | null, order: PlatformOrderRow): Promise<HomeCopy> {
  const fallback: HomeCopy = {
    tagline: `歡迎來到 ${order.brand_name}`,
    about: `${order.brand_name} 的官方網站。這是系統依你的品牌自動產生的草稿，請在店主後台「內容編輯」改成你的介紹，再按發布。`,
    features: order.modules.map((m) => MODULE_FEATURE[m]).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 4),
  };
  if (!fallback.features.length) fallback.features = [{ title: "我們的服務", body: "在這裡介紹你提供的服務或商品。", icon: "✨" }];
  if (!gemini) return fallback;
  try {
    const raw = await gemini({
      system: "你是台灣的品牌網站文案助手。只輸出 JSON：{\"tagline\":\"一句話標語（30 字內）\",\"about\":\"品牌介紹 2–3 句（150 字內）\",\"features\":[{\"title\":\"8 字內\",\"body\":\"40 字內\",\"icon\":\"一個 emoji\"}]}（features 3 個）。繁體中文，不要捏造價格、地址、電話、獲獎紀錄。",
      turns: [{ role: "user", text: `品牌名稱：${order.brand_name}\n網站功能：${order.modules.join("、")}` }],
    });
    const j = JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as Partial<HomeCopy>;
    return {
      tagline: typeof j.tagline === "string" && j.tagline.trim() ? j.tagline.trim().slice(0, 120) : fallback.tagline,
      about: typeof j.about === "string" && j.about.trim() ? j.about.trim().slice(0, 1000) : fallback.about,
      features: Array.isArray(j.features) && j.features.length ? j.features.slice(0, 6).map((f) => ({ title: String(f?.title ?? "").slice(0, 80) || "特色", body: String(f?.body ?? "").slice(0, 600) || "說明", icon: typeof f?.icon === "string" ? f.icon.slice(0, 4) : undefined })) : fallback.features,
    };
  } catch (e) {
    console.error("[platform-billing] AI 首頁草稿失敗，改用模板", e instanceof Error ? e.message : e);
    return fallback;
  }
}

function homepageContent(c: SiteContent, order: PlatformOrderRow, copy: HomeCopy): SiteContent {
  const page = c.pages[0]!;
  const want: { type: string; props: Record<string, unknown> }[] = [
    { type: "hero", props: { heading: order.brand_name ?? "", subheading: copy.tagline, align: "center", ...(order.modules.includes("contact-form") ? { ctaLabel: "聯絡我們", ctaHref: "#contact" } : {}) } },
    { type: "rich_text", props: { heading: "關於我們", markdown: copy.about } },
    { type: "features", props: { heading: "我們提供", items: copy.features.map((f) => ({ title: f.title, body: f.body, ...(f.icon ? { icon: f.icon } : {}) })) } },
    ...(order.modules.includes("contact-form") ? [{ type: "contact_form", props: { heading: "聯絡我們", intro: "留下訊息，我們會盡快回覆。" } }] : []),
  ];
  page.sections = want.flatMap((s) => {
    const v = validateSectionProps(s.type, s.props);
    return v.ok ? [{ id: newSectionId(), type: s.type, props: v.props }] : [];
  });
  return c;
}

/* ================================================================== 查詢、店主後台 */

export function orderSummary(o: PlatformOrderRow) {
  return {
    orderNo: o.order_no,
    kind: o.kind,
    status: o.status,
    slug: o.slug,
    brandName: o.brand_name,
    modules: o.modules,
    amountSetup: o.amount_setup,
    amountMonthly: o.amount_monthly,
    amountTotal: o.amount_total,
    sandbox: o.sandbox,
    isTest: o.is_test,
    paidAt: o.paid_at,
    provisionState: o.provision_state,
    provisionError: o.provision_state === "failed" ? o.provision_error : null,
    expiresAt: o.expires_at,
    periodEnd: o.period_end,
  };
}

/** 付款頁／MCP get_build_status：要訂單編號＋存取金鑰（或平台 token）。待付款且有付款紀錄時順便回查一次（付款完回到頁面就能看到結果） */
export async function getPlatformOrderStatus(deps: PlatformDeps, input: { orderNo: string; accessKey?: unknown; trusted?: boolean }) {
  let o = await deps.store.getPlatformOrderByNo(input.orderNo);
  if (!o || (!input.trusted && !checkAccessKey(o, input.accessKey))) throw new ServiceError("not_found", "找不到這張訂單");
  if ((o.status === "pending_payment" && o.gateway_order_no) || (o.status === "paid" && o.provision_state !== "done")) {
    await settleFromQuery(deps, o).catch((e) => console.error("[platform-billing] status 回查", e));
    o = (await deps.store.getPlatformOrderById(o.id)) ?? o;
  }
  const tenant = o.tenant_id ? await deps.store.getTenantById(o.tenant_id) : null;
  return {
    ...orderSummary(o),
    siteUrl: tenant ? siteBase(tenant, deps.baseUrl) : null,
    ownerUrl: tenant ? `${deps.baseUrl.replace(/\/$/, "")}/owner/t/${tenant.slug}` : null,
    paymentsOpen: !!platformPayConfig(),
  };
}

export async function billingSummary(ctx: ServiceContext, input: { site?: string | null }) {
  const tenant = await resolveTenant(ctx, input.site);
  const b = await ctx.store.getTenantBilling(tenant.id);
  const orders = await ctx.store.listPlatformOrders({ tenantId: tenant.id, limit: 30 });
  const enabled = (await ctx.store.listTenantModules(tenant.id)).filter((m) => m.status !== "disabled").map((m) => m.module_id);
  return { billing: b, orders: orders.map(orderSummary), enabledModules: enabled, paymentsOpen: !!platformPayConfig() };
}

/** 店主停止續費／恢復續費（owner 角色或平台後台）。停止＝到期後停站（不刪資料） */
export async function setRenewal(ctx: ServiceContext, input: { site?: string | null; cancel: boolean; confirm?: boolean }) {
  if (ctx.actor.kind !== "admin") requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const b = await ctx.store.getTenantBilling(tenant.id);
  if (!b) throw new ServiceError("invalid", "這個網站沒有平台月費");
  if (input.cancel && input.confirm !== true) throw new ServiceError("confirm_required", `停止續費後，網站在 ${b.paid_until.slice(0, 10)} 到期後會停止服務（資料保留，之後付款可恢復）。請確認後以 confirm: true 呼叫。`);
  const next = await ctx.store.updateTenantBilling(tenant.id, { cancel_at_period_end: input.cancel, ...(input.cancel ? {} : b.status === "cancelled" ? { status: "active" as const } : {}) });
  await audit(ctx, tenant.id, input.cancel ? "billing.cancel_renewal" : "billing.resume_renewal", { paidUntil: b.paid_until });
  return { cancelAtPeriodEnd: next?.cancel_at_period_end ?? input.cancel, paidUntil: b.paid_until };
}

/* ================================================================== 每日 cron */

export async function sweepPlatformBilling(deps: PlatformDeps, nowMs = Date.now()) {
  const out = { expired: 0, settled: 0, provisioned: 0, renewals: 0, pastDue: 0, suspended: 0 };
  const nowIso = new Date(nowMs).toISOString();
  for (const o of await deps.store.listPlatformOrdersForSweep(nowIso, new Date(nowMs - PROVISION_STALE_MS).toISOString(), 100)) {
    if (o.status === "paid") {
      if ((await provisionPlatformOrder(deps, o.id)).ok) out.provisioned++;
      continue;
    }
    if (o.status === "expired") {
      // 第九批審查 M2：逾期但已建立付款的單 → 回查；逾期後才付款的照常處理（開站或 paid_needs_attention）
      const r = await settleFromQuery(deps, o);
      if (r === "paid" || r === "paid_needs_attention") out.settled++;
      continue;
    }
    // 逾期前先權威回查：已付 → 開站；回查失敗／無法辨識 → 這次不動
    if (o.gateway_order_no) {
      const r = await settleFromQuery(deps, o);
      if (r === "paid" || r === "already_paid") {
        out.settled++;
        continue;
      }
      if (r === "query_failed" || r === "unknown" || r === "missing_amount") continue;
    }
    if (await deps.store.updatePlatformOrder(o.id, { status: "expired" }, { status: ["pending_payment"] })) out.expired++;
  }
  // 月費：到期前 7 天建續費單＋寄付款連結；過期進寬限；寬限結束（或停止續費）停站
  for (const b of await deps.store.listBillingDue(new Date(nowMs + RENEWAL_LEAD_MS).toISOString(), 200)) {
    const tenant = await deps.store.getTenantById(b.tenant_id);
    if (!tenant) continue;
    const paidUntil = Date.parse(b.paid_until);
    if (paidUntil > nowMs) {
      if (!b.cancel_at_period_end && b.status === "active" && (await createRenewalOrder(deps, tenant, b.paid_until, b.monthly_amount))) out.renewals++;
      continue;
    }
    if (b.cancel_at_period_end || (b.grace_until && Date.parse(b.grace_until) <= nowMs)) {
      if (await deps.store.updateTenantBilling(tenant.id, { status: "suspended", suspended_at: nowIso }, ["active", "past_due", "cancelled"])) {
        await deps.store.updateTenant(tenant.id, { status: "suspended" });
        await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:billing", action: "billing.suspend", payload: { paidUntil: b.paid_until, cancelled: b.cancel_at_period_end } });
        await mail(deps, await ownerContact(deps.store, tenant), `【Gather Builder】網站「${tenant.name}」已暫停服務`, `你好，\n\n網站月費已於 ${b.paid_until.slice(0, 10)} 到期${b.cancel_at_period_end ? "（你已停止續費）" : "，寬限期內未完成付款"}，網站已暫停對外服務。資料都還保留，到店主後台「方案與加購」付款即可恢復：\n${deps.baseUrl.replace(/\/$/, "")}/owner/t/${tenant.slug}/billing`);
        out.suspended++;
      }
      continue;
    }
    if (b.status === "active" && (await deps.store.updateTenantBilling(tenant.id, { status: "past_due", grace_until: new Date(paidUntil + GRACE_MS).toISOString() }, ["active"]))) out.pastDue++;
    if (!b.cancel_at_period_end) await createRenewalOrder(deps, tenant, b.paid_until, b.monthly_amount);
  }
  return out;
}

/** 建這一期的續費單（同一期只一張：partial unique）＋寄付款連結；已經有就不重寄 */
async function createRenewalOrder(deps: PlatformDeps, tenant: TenantRow, periodStartIso: string, monthly: number): Promise<{ order: PlatformOrderRow; accessKey: string } | null> {
  const cfg = platformPayConfig();
  if (!cfg || monthly <= 0) return null;
  const accessKey = randomBytes(24).toString("base64url");
  let order: PlatformOrderRow;
  try {
    order = await deps.store.insertPlatformOrder({
      order_no: newOrderNo(),
      kind: "renewal",
      tenant_id: tenant.id,
      slug: null,
      brand_name: tenant.name,
      theme_preset: null,
      contact_email: await ownerContact(deps.store, tenant),
      modules: [],
      amount_setup: 0,
      amount_monthly: monthly,
      amount_total: monthly,
      period_start: periodStartIso,
      period_end: new Date(Date.parse(periodStartIso) + MONTH_MS).toISOString(),
      sandbox: cfg.sandbox,
      is_test: tenant.is_test || cfg.sandbox,
      access_key_hash: sha256(accessKey),
      expires_at: new Date(Date.parse(periodStartIso) + GRACE_MS).toISOString(),
      created_by: "system:billing",
    });
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") return null; // 這一期已經有續費單
    throw e;
  }
  await mail(deps, order.contact_email, `【Gather Builder】網站「${tenant.name}」月費帳單 ${twd(monthly)}`, `你好，\n\n網站月費將於 ${periodStartIso.slice(0, 10)} 到期，下一期 ${twd(monthly)}。請在到期後 7 天內付款，逾期網站會暫停服務（資料保留）：\n${orderStatusUrl(deps.baseUrl, order.order_no, accessKey)}\n\n不想續用：到店主後台「方案與加購」停止續費。`);
  return { order, accessKey };
}

/**
 * 店主後台「付月費」（停站後恢復、或想提早付）：已有待付款續費單 → 換新金鑰沿用；沒有 → 建一張
 * （已過期／停站：新的一期從現在開始；還沒到期：從 paid_until 接續）。owner 角色或平台後台。
 */
export async function requestRenewalOrder(ctx: ServiceContext, input: { site?: string | null }) {
  if (ctx.actor.kind !== "admin") requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const b = await ctx.store.getTenantBilling(tenant.id);
  if (!b) throw new ServiceError("invalid", "這個網站沒有平台月費");
  const pending = (await ctx.store.listPlatformOrders({ tenantId: tenant.id, kind: "renewal", status: ["pending_payment"], limit: 5 })).find((o) => Date.parse(o.expires_at) > Date.now());
  if (pending) return ownerPaymentLink(ctx, { site: tenant.slug, orderNo: pending.order_no });
  const start = Date.parse(b.paid_until) > Date.now() ? b.paid_until : new Date().toISOString();
  const r = await createRenewalOrder({ store: ctx.store, baseUrl: ctx.baseUrl, previewSecret: ctx.previewSecret, sendMail: ctx.sendMail }, tenant, start, b.monthly_amount);
  if (!r) throw new ServiceError("invalid", "目前無法建立續費單（平台尚未開放付款）");
  await audit(ctx, tenant.id, "billing.renewal_request", { orderNo: r.order.order_no });
  return { statusUrl: orderStatusUrl(ctx.baseUrl, r.order.order_no, r.accessKey) };
}

/** 店主後台「前往付款」（續費／加購的待付款單）：換一把新的存取金鑰（舊連結失效）→ 回傳付款頁網址。owner 角色或平台後台 */
export async function ownerPaymentLink(ctx: ServiceContext, input: { site?: string | null; orderNo: string }) {
  if (ctx.actor.kind !== "admin") requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const o = await ctx.store.getPlatformOrderByNo(input.orderNo);
  if (!o || o.tenant_id !== tenant.id) throw new ServiceError("not_found", "找不到這張訂單");
  if (o.status !== "pending_payment") throw new ServiceError("conflict", "這張訂單不是待付款");
  const accessKey = randomBytes(24).toString("base64url");
  await ctx.store.updatePlatformOrder(o.id, { access_key_hash: sha256(accessKey) }, { status: ["pending_payment"] });
  return { statusUrl: orderStatusUrl(ctx.baseUrl, o.order_no, accessKey) };
}

export { BASE_MODULES };
