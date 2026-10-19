import { createHash, randomBytes } from "node:crypto";
import { shippingSettings, type ShippingMethod, type ShippingSettings } from "@/modules/shipping/manifest";
import type { OrderRow, ShipmentRow, ShipmentStatus, ShippingChoice, Store, TenantRow } from "../store/types";
import { decryptSecret, encryptSecret } from "../secretbox";
import {
  CVS_LABEL,
  CVS_SUBTYPES,
  ECPAY_NAME_RULE,
  createLogisticsOrder,
  isValidCellPhone,
  isValidEcpayName,
  mapForm,
  mapLogisticsStatus,
  queryLogisticsOrder,
  randomTradeNo,
  verifyCheckMacValue,
  type EcpayCreds,
} from "../shipping/ecpay";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { publishedModuleSettings } from "./members";
import { mailSafe, orderPageUrl } from "./shop";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 電子地圖選店暫存的有效時間 */
export const CVS_SELECTION_TTL_MS = 30 * 60_000;

/* ================================================================== 設定與可用性 */

export async function shippingActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("shipping");
}

/** 已發布的物流設定；模組未啟用或設定不完整回 null */
export async function publishedShippingSettings(store: Store, tenant: TenantRow): Promise<ShippingSettings | null> {
  if (!(await shippingActive(store, tenant.id))) return null;
  const raw = await publishedModuleSettings(store, tenant, "shipping");
  const r = shippingSettings.safeParse(raw);
  return r.success ? r.data : null;
}

export function methodFee(m: Pick<ShippingMethod, "fee" | "freeThreshold">, subtotal: number): number {
  return m.freeThreshold !== undefined && subtotal >= m.freeThreshold ? 0 : m.fee;
}

async function ecpayCreds(store: Store, tenantId: string): Promise<(EcpayCreds & { kind: "C2C" | "B2C" }) | null> {
  const acct = await store.getShippingAccount(tenantId);
  if (!acct) return null;
  const sec = JSON.parse(decryptSecret(acct.secret_enc, tenantId)) as { hashKey: string; hashIv: string };
  return { merchantId: acct.merchant_id, hashKey: sec.hashKey, hashIv: sec.hashIv, stage: acct.stage, kind: acct.kind };
}

/**
 * 結帳頁可選的運送方式。綠界方式需要已設定的綠界帳號，且 C2C／B2C 子類型要跟帳號類型相符；
 * 🔴 綠界「測試環境」帳號只在帶預覽簽章時提供（同 PChomePay sandbox 規則：已發布網站的訪客不會選到假物流）。
 */
export async function availableShippingMethods(store: Store, tenant: TenantRow, settings: ShippingSettings, opts: { allowStage?: boolean } = {}) {
  const acct = await store.getShippingAccount(tenant.id);
  return settings.methods.filter((m) => {
    if (m.provider !== "ecpay") return true;
    if (!acct || (acct.stage && !opts.allowStage)) return false;
    if (m.type === "cvs") return (CVS_SUBTYPES[acct.kind] as readonly string[]).includes(m.subType ?? "");
    return true;
  });
}

/* ================================================================== 電子地圖選店 */

export function cvsCookieName(tenantId: string) {
  return `gbcvs_${tenantId.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * 開始選門市：建一筆暫存（MerchantTradeNo 隨機、只存 sha256；另一個瀏覽器秘密只存 sha256 當 binding），
 * 回傳要自動 POST 到綠界的表單與要設在瀏覽器的 binding cookie 值。
 */
/** 第八批：團購頁選店後回到團購頁（只接受 /groupbuy/<slug>） */
export const CVS_RETURN_PATH = /^\/groupbuy\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export async function startCvsSelection(store: Store, tenant: TenantRow, input: { methodId: string; baseUrl: string; mobile: boolean; allowStage?: boolean; returnPath?: string | null }) {
  const settings = await publishedShippingSettings(store, tenant);
  if (!settings) throw new ServiceError("forbidden", "此網站未開放超商取貨");
  const m = (await availableShippingMethods(store, tenant, settings, { allowStage: input.allowStage })).find((x) => x.id === input.methodId);
  if (!m || m.type !== "cvs" || !m.subType) throw new ServiceError("invalid", "請選擇超商取貨方式");
  const creds = await ecpayCreds(store, tenant.id);
  if (!creds) throw new ServiceError("invalid", "此商店尚未設定超商物流");
  const tradeNo = randomTradeNo("M");
  const binding = randomBytes(32).toString("base64url");
  await store.insertCvsSelection({
    tenant_id: tenant.id,
    trade_no_hash: sha256(tradeNo),
    binding_hash: sha256(binding),
    sub_type: m.subType,
    method_id: m.id,
    expires_at: new Date(Date.now() + CVS_SELECTION_TTL_MS).toISOString(),
    ...(input.returnPath && CVS_RETURN_PATH.test(input.returnPath) ? { return_path: input.returnPath } : {}),
  });
  const form = mapForm(creds, { tradeNo, subType: m.subType, serverReplyUrl: `${input.baseUrl.replace(/\/$/, "")}/api/ship/ecpay/map/${tenant.id}`, mobile: input.mobile });
  return { form, binding, maxAgeSeconds: CVS_SELECTION_TTL_MS / 1000 };
}

/**
 * 綠界電子地圖回傳（瀏覽器從綠界頁面 POST 過來，沒有 CheckMacValue）。安全性靠：
 * 1. 路徑上的租戶＋該租戶的綠界 MerchantID 必須相符（來源檢查）；
 * 2. MerchantTradeNo 是 20 碼隨機值、只有這次結帳的瀏覽器與綠界知道 → 只能寫回「它自己」那筆暫存；
 * 3. 子類型必須等於當初要求的，暫存未使用、未過期才寫；
 * 4. 下單時還要再出示 binding cookie（consumeCvsSelection），別人的瀏覽器拿不到。
 */
export async function handleCvsMapCallback(store: Store, tenantId: string, form: Record<string, string>): Promise<{ ok: boolean; slug: string | null; selectionId: string | null; message: string; returnPath?: string | null }> {
  const tenant = await store.getTenantById(tenantId);
  if (!tenant) return { ok: false, slug: null, selectionId: null, message: "找不到網站" };
  const acct = await store.getShippingAccount(tenantId);
  if (!acct || (form.MerchantID ?? "") !== acct.merchant_id) return { ok: false, slug: tenant.slug, selectionId: null, message: "門市資料來源不正確" };
  const tradeNo = (form.MerchantTradeNo ?? "").trim();
  const storeId = (form.CVSStoreID ?? "").trim();
  if (!/^[A-Za-z0-9]{10,20}$/.test(tradeNo) || !/^[A-Za-z0-9]{1,10}$/.test(storeId)) return { ok: false, slug: tenant.slug, selectionId: null, message: "門市資料不完整，請重新選擇" };
  const row = await store.setCvsSelectionStore(
    sha256(tradeNo),
    (form.LogisticsSubType ?? "").trim(),
    { id: storeId, name: (form.CVSStoreName ?? "").trim().slice(0, 40), address: (form.CVSAddress ?? "").trim().slice(0, 120), outside: (form.CVSOutSide ?? "0").trim() === "1" },
    new Date().toISOString(),
  );
  if (!row || row.tenant_id !== tenantId) return { ok: false, slug: tenant.slug, selectionId: null, message: "選店已逾時或無效，請重新選擇門市" };
  return { ok: true, slug: tenant.slug, selectionId: row.id, message: "已選擇門市", returnPath: row.return_path && CVS_RETURN_PATH.test(row.return_path) ? row.return_path : null };
}

/** 結帳頁：只有持有 binding cookie 的瀏覽器看得到自己選的門市 */
export async function selectionForBrowser(store: Store, tenant: TenantRow, selectionId: string | undefined, binding: string | undefined) {
  if (!selectionId || !binding) return null;
  const s = await store.getCvsSelection(tenant.id, selectionId);
  if (!s || s.binding_hash !== sha256(binding) || !s.store || s.used_at || new Date(s.expires_at).getTime() <= Date.now()) return null;
  return { id: s.id, methodId: s.method_id, store: s.store };
}

/* ================================================================== 結帳：運送方式（server 計價） */

export interface ShippingResolution {
  fee: number;
  choice: ShippingChoice;
  /** 下單失敗時要歸還的選店暫存 */
  consumedSelectionId: string | null;
}

/**
 * 依「已發布設定」決定運費與運送方式（前端送來的運費一律不採信）。
 * 超商：原子消耗選店暫存（同租戶、binding 相符、子類型相符、未使用未過期），綁不到別人的結帳。
 * consume=false 時只計價（購物車試算用），不消耗暫存。
 */
export async function resolveShipping(
  store: Store,
  tenant: TenantRow,
  input: { methodId?: string | null; cvsSelectionId?: string | null; binding?: string | null; subtotal: number; receiver?: { name: string; phone: string }; consume: boolean; allowStage?: boolean },
): Promise<ShippingResolution | null> {
  const settings = await publishedShippingSettings(store, tenant);
  if (!settings) return null;
  const methods = await availableShippingMethods(store, tenant, settings, { allowStage: input.allowStage });
  if (!methods.length) throw new ServiceError("invalid", "此商店目前沒有可用的運送方式");
  const m = methods.find((x) => x.id === input.methodId);
  if (!m) {
    if (!input.consume) {
      const min = Math.min(...methods.map((x) => methodFee(x, input.subtotal)));
      return { fee: min, choice: { methodId: "", type: "manual", provider: "manual", subType: null, label: "（尚未選擇運送方式）", fee: min, store: null, cvsSelectionId: null }, consumedSelectionId: null };
    }
    throw new ServiceError("invalid", "請選擇運送方式");
  }
  const fee = methodFee(m, input.subtotal);
  const choice: ShippingChoice = { methodId: m.id, type: m.type, provider: m.provider, subType: m.subType ?? null, label: m.label, fee, store: null, cvsSelectionId: null };
  if (m.provider === "ecpay" && (await store.getShippingAccount(tenant.id))?.stage) choice.stage = true;
  if (input.consume && m.provider === "ecpay" && input.receiver) {
    if (!isValidEcpayName(input.receiver.name)) throw new ServiceError("invalid", ECPAY_NAME_RULE);
    if (!isValidCellPhone(input.receiver.phone)) throw new ServiceError("invalid", "超商取貨與綠界宅配的收件人電話需為手機（09 開頭 10 碼）");
  }
  if (m.type === "cvs" && input.consume) {
    if (!input.cvsSelectionId || !input.binding) throw new ServiceError("invalid", "請先選擇取貨門市");
    const sel = await store.consumeCvsSelection(tenant.id, input.cvsSelectionId, sha256(input.binding), new Date().toISOString());
    if (!sel) throw new ServiceError("invalid", "取貨門市已逾時或無效，請重新選擇門市");
    if (sel.method_id !== m.id || sel.sub_type !== m.subType) {
      await store.releaseCvsSelection(tenant.id, sel.id);
      throw new ServiceError("invalid", "選擇的門市與運送方式不符，請重新選擇門市");
    }
    choice.store = sel.store;
    choice.cvsSelectionId = sel.id;
    return { fee, choice, consumedSelectionId: sel.id };
  }
  return { fee, choice, consumedSelectionId: null };
}

/* ================================================================== 綠界憑證（只限平台後台） */

function requireAdminActor(ctx: ServiceContext) {
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "物流憑證只能從平台後台表單輸入（不經過 agent 對話）");
}
async function requireShipping(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await shippingActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「shipping」，請先 enable_module shipping");
}
const mask = (s: string) => (s.length <= 3 ? "***" : `${"*".repeat(s.length - 3)}${s.slice(-3)}`);

export async function saveShippingAccount(ctx: ServiceContext, input: { site: string; merchantId: string; hashKey: string; hashIv: string; stage: boolean; kind: "C2C" | "B2C" }) {
  requireAdminActor(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  await requireShipping(ctx, tenant);
  const merchantId = input.merchantId.trim();
  const hashKey = input.hashKey.trim();
  const hashIv = input.hashIv.trim();
  if (!/^[0-9A-Za-z]{1,10}$/.test(merchantId)) throw new ServiceError("invalid", "MerchantID 格式不正確");
  if (!/^[0-9A-Za-z]{8,64}$/.test(hashKey) || !/^[0-9A-Za-z]{8,64}$/.test(hashIv)) throw new ServiceError("invalid", "HashKey／HashIV 格式不正確");
  await ctx.store.upsertShippingAccount({ tenant_id: tenant.id, provider: "ecpay", merchant_id: merchantId, secret_enc: encryptSecret(JSON.stringify({ hashKey, hashIv }), tenant.id), stage: input.stage, kind: input.kind });
  await audit(ctx, tenant.id, "shipping_account.save", { provider: "ecpay", stage: input.stage, kind: input.kind, merchantId: mask(merchantId) });
  return { saved: true };
}

export async function getShippingSetupStatus(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShipping(ctx, tenant);
  const [acct, settings, states] = await Promise.all([ctx.store.getShippingAccount(tenant.id), publishedShippingSettings(ctx.store, tenant), moduleStates(ctx, tenant.id)]);
  return {
    shippingModuleStatus: states.get("shipping")?.status ?? "disabled",
    methods: settings?.methods.map((m) => ({ id: m.id, type: m.type, provider: m.provider, subType: m.subType ?? null, label: m.label, fee: m.fee, freeThreshold: m.freeThreshold ?? null })) ?? [],
    ecpay: acct ? { configured: true, stage: acct.stage, kind: acct.kind, merchantId: mask(acct.merchant_id) } : { configured: false },
    note: `綠界憑證只能由平台擁有者在後台「物流」輸入；MCP 無法設定或讀出。${acct?.stage ? "目前是綠界測試環境帳號：只有帶預覽簽章的結帳看得到綠界運送方式，建立的物流單不會真的寄送。" : ""}`,
  };
}

/* ================================================================== 出貨單 */

const RANK: Record<ShipmentStatus, number> = { created: 0, in_transit: 1, arrived: 2, delivered: 3, returned: 3, failed: -1, cancelled: -1 };
const SHIPPED: ShipmentStatus[] = ["in_transit", "arrived", "delivered"];

export function shipmentSummary(s: ShipmentRow, orderNo?: string) {
  return {
    id: s.id,
    orderNo,
    method: s.method_id,
    type: s.method_type,
    provider: s.provider,
    subType: s.sub_type,
    subTypeLabel: s.sub_type ? (CVS_LABEL[s.sub_type] ?? s.sub_type) : null,
    status: s.status,
    stage: s.stage,
    logisticsId: s.logistics_id,
    trackingNo: s.tracking_no,
    validationNo: s.validation_no,
    store: s.store,
    events: s.events.slice(-10),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/** 出貨單狀態變成「已寄出」→ 訂單 paid → fulfilled（條件式，只會一次）並通知客人 */
async function markOrderShipped(store: Store, sendMail: ServiceContext["sendMail"], baseUrl: string, tenant: TenantRow, order: OrderRow, s: ShipmentRow) {
  await store.setOrderFields(tenant.id, order.id, { shipping_tracking: s.tracking_no, shipping_method: order.shipping_choice?.label ?? s.method_id });
  if (order.status !== "paid" || isTopupOrder(order)) return;
  const moved = await store.transitionOrder(tenant.id, order.id, "paid", "fulfilled", { fulfilled_at: new Date().toISOString(), shipping_tracking: s.tracking_no, shipping_method: order.shipping_choice?.label ?? s.method_id });
  if (!moved) return;
  await store.insertAudit({ tenant_id: tenant.id, actor: "system:shipping", action: "order.fulfill", payload: { orderNo: order.order_no, shipment: s.id, status: s.status } });
  await mailSafe(
    { sendMail },
    order.contact.email,
    `【${tenant.name}】訂單已出貨 ${order.order_no}`,
    `${order.contact.name} 你好，訂單 ${order.order_no} 已出貨（${order.shipping_choice?.label ?? "物流"}）。${s.tracking_no ? `\n物流單號：${s.tracking_no}` : ""}${s.store ? `\n取貨門市：${s.store.name}（${s.store.address}）` : ""}\n\n訂單狀態：${orderPageUrl(baseUrl, tenant, order.order_no)}`,
  );
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 建立出貨單（需 confirm）。
 * - 綠界：先在 DB 宣告（同一訂單只能有一張有效出貨單，唯一索引保證），再呼叫綠界 Express/Create；失敗標 failed 釋放名額。
 *   訂單維持「已付款」，等物流狀態通知（已寄出）才轉「已出貨」——以物流狀態為準。
 * - 手動出貨／自取／手動宅配：記錄追蹤號，訂單直接轉「已出貨」。
 */
export async function createShipment(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string; confirm?: boolean; trackingNumber?: string }, fetchImpl?: FetchLike) {
  requireScope(ctx, "shipping:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShipping(ctx, tenant);
  const order = input.orderId ? await ctx.store.getOrderById(tenant.id, input.orderId) : input.orderNo ? await ctx.store.getOrderByNo(tenant.id, input.orderNo) : null;
  if (!order) throw new ServiceError("not_found", "找不到訂單（請給 orderId 或 orderNo）");
  if (order.status !== "paid") throw new ServiceError("conflict", `訂單 ${order.order_no} 目前不是「已付款」，不能建立出貨單`);
  if (order.payment_sandbox) throw new ServiceError("invalid", `訂單 ${order.order_no} 是金流測試環境付款（沒有實際收款），不能出貨`);
  if (isTopupOrder(order)) throw new ServiceError("invalid", `訂單 ${order.order_no} 是儲值訂單，不需要出貨`);
  const choice: ShippingChoice = order.shipping_choice ?? { methodId: "manual", type: "manual", provider: "manual", subType: null, label: "手動出貨", fee: order.shipping_fee, store: null, cvsSelectionId: null };
  const settings = await publishedShippingSettings(ctx.store, tenant);
  const active = await ctx.store.getActiveShipmentByOrder(tenant.id, order.id);
  if (active) {
    // M-4：上次建單結果不明（逾時／連線錯誤、或寫入後行程中斷）→ 先用原 MerchantTradeNo 反查，絕不直接另建一張
    if (active.provider === "ecpay" && active.status === "created" && !active.logistics_id && active.merchant_trade_no) {
      return reconcileUnknownShipment(ctx, tenant, order, active, choice, settings, input.confirm, fetchImpl);
    }
    throw new ServiceError("conflict", `訂單 ${order.order_no} 已經有出貨單了（get_shipment 查看）`);
  }

  if (choice.provider !== "ecpay") {
    const tracking = input.trackingNumber?.trim().slice(0, 100) || null;
    if (choice.type !== "pickup" && !tracking) throw new ServiceError("invalid", "手動出貨請帶 trackingNumber（物流追蹤號）");
    if (input.confirm !== true) throw new ServiceError("confirm_required", `把訂單 ${order.order_no} 標記為已出貨（${choice.label}${tracking ? `，追蹤號 ${tracking}` : ""}）會通知客人。請先讓使用者確認，再以 confirm: true 呼叫。`);
    const s = await ctx.store.insertShipment({
      tenant_id: tenant.id,
      order_id: order.id,
      method_id: choice.methodId,
      method_type: choice.type,
      provider: "manual",
      sub_type: null,
      merchant_trade_no: null,
      logistics_id: null,
      store: null,
      tracking_no: tracking,
      validation_no: null,
      status: choice.type === "pickup" ? "arrived" : "in_transit",
      stage: false,
      raw: null,
      events: [{ at: new Date().toISOString(), code: null, message: `店主手動出貨（${ctx.actor.label}）`, status: choice.type === "pickup" ? "arrived" : "in_transit" }],
    });
    await audit(ctx, tenant.id, "shipment.create", { orderNo: order.order_no, provider: "manual", tracking });
    await markOrderShipped(ctx.store, ctx.sendMail, ctx.baseUrl, tenant, order, s);
    return { ...shipmentSummary(s, order.order_no), note: "已記錄出貨並通知客人。" };
  }

  // 綠界
  const creds = await ecpayCreds(ctx.store, tenant.id);
  if (!creds) throw new ServiceError("invalid", "此商店尚未設定綠界物流憑證（請平台擁有者到後台「物流」輸入）");
  assertStageAllowed(creds, order);
  if (!settings?.sender) throw new ServiceError("invalid", "請先在 shipping 模組設定寄件人（sender）並發布");
  if (choice.type === "cvs" && !choice.store) throw new ServiceError("invalid", "訂單沒有取貨門市資料");
  if (!isValidEcpayName(order.shipping.name)) throw new ServiceError("invalid", `${ECPAY_NAME_RULE}（目前：${order.shipping.name}），請與客人確認後改用手動出貨`);
  const zip = /^\s*(\d{3,6})/.exec(order.shipping.address)?.[1];
  if (choice.type === "home" && !zip) throw new ServiceError("invalid", "綠界宅配需要收件地址開頭的郵遞區號（例如「100台北市…」），請與客人確認後改用手動出貨");
  if (input.confirm !== true) {
    throw new ServiceError("confirm_required", `建立綠界${creds.stage ? "【測試環境】" : ""}物流單（${choice.label}${choice.store ? `，門市 ${choice.store.name}` : ""}）${creds.stage ? "" : "會產生真實寄件與運費"}。請先讓使用者確認，再以 confirm: true 呼叫。`);
  }
  const tradeNo = randomTradeNo("S");
  const claim = await ctx.store.insertShipment({
    tenant_id: tenant.id,
    order_id: order.id,
    method_id: choice.methodId,
    method_type: choice.type,
    provider: "ecpay",
    sub_type: choice.subType,
    merchant_trade_no: tradeNo,
    logistics_id: null,
    store: choice.store,
    tracking_no: null,
    validation_no: null,
    status: "created",
    stage: creds.stage,
    raw: null,
    events: [{ at: new Date().toISOString(), code: null, message: "送出建單", status: "created" }],
  });
  return sendEcpayCreate(ctx, tenant, order, claim, choice, creds, settings, zip, { retry: false }, fetchImpl);
}

/** L-5：綠界測試環境帳號只能處理「預覽／sandbox」訂單（真實付款的訂單不能拿 stage 帳號出假物流單） */
function assertStageAllowed(creds: { stage: boolean }, order: OrderRow) {
  if (creds.stage && !order.payment_sandbox && !order.shipping_choice?.stage) {
    throw new ServiceError("invalid", `目前的綠界帳號是測試環境（stage），只能處理預覽／測試訂單；訂單 ${order.order_no} 是正式訂單，請平台擁有者換成正式綠界帳號，或改用手動出貨`);
  }
}

type EcpayFull = EcpayCreds & { kind: "C2C" | "B2C" };

/** 打 Express/Create 並依結果更新出貨單：成功 → 寫物流編號；結果不明 → 維持 created（下次先反查）；確定失敗 → failed（可重建） */
async function sendEcpayCreate(
  ctx: ServiceContext,
  tenant: TenantRow,
  order: OrderRow,
  claim: ShipmentRow,
  choice: ShippingChoice,
  creds: EcpayFull,
  settings: ShippingSettings | null,
  zip: string | undefined,
  opts: { retry: boolean },
  fetchImpl?: FetchLike,
) {
  const tradeNo = claim.merchant_trade_no!;
  const r = await createLogisticsOrder(
    creds,
    {
      tradeNo,
      type: choice.type === "cvs" ? "cvs" : "home",
      subType: choice.subType ?? "",
      goodsAmount: order.total,
      goodsName: settings?.goodsName ?? `${tenant.name} 訂單`,
      sender: settings!.sender!,
      receiver: { name: order.shipping.name.trim(), cellPhone: order.shipping.phone, email: order.contact.email, storeId: choice.store?.id, zipCode: zip, address: order.shipping.address.replace(/^\s*\d{3,6}\s*/, "") },
      serverReplyUrl: `${ctx.baseUrl.replace(/\/$/, "")}/api/ship/ecpay/notify/${tenant.id}`,
    },
    fetchImpl,
  );
  const ev = (message: string, status: ShipmentStatus | null, code: string | null = null) => ({ at: new Date().toISOString(), code, message: message.slice(0, 200), status });
  if (!r.ok) {
    if (r.unknown) {
      await ctx.store.updateShipment(tenant.id, claim.id, { raw: { ...(r.raw as Record<string, unknown>), unknown: true }, events: [...claim.events, ev(`結果不明：${r.message}`, "created")] });
      await audit(ctx, tenant.id, "shipment.unknown", { orderNo: order.order_no, tradeNo, message: r.message.slice(0, 200) });
      throw new ServiceError("conflict", `綠界建單結果不明（${r.message}）。出貨單維持「建立中」，綠界可能已經建好單；請稍後再呼叫一次 create_shipment，系統會先用原交易編號 ${tradeNo} 向綠界反查，確定沒有才重送。`);
    }
    if (opts.retry) {
      // 重送被拒（可能是同一個 MerchantTradeNo 剛被另一個請求建好）→ 再反查一次，查到就認回
      const q = await queryLogisticsOrder(creds, tradeNo, fetchImpl);
      if (q.kind === "found") return adoptShipment(ctx, tenant, order, claim, choice, q);
    }
    await ctx.store.updateShipment(tenant.id, claim.id, { status: "failed", raw: r.raw as Record<string, unknown>, events: [...claim.events, ev(r.message, "failed")] });
    await audit(ctx, tenant.id, "shipment.fail", { orderNo: order.order_no, message: r.message.slice(0, 200) });
    throw new ServiceError("invalid", `${r.message}（出貨單已標失敗，可修正後重新建立）`);
  }
  const s = await ctx.store.updateShipment(tenant.id, claim.id, {
    logistics_id: r.logisticsId,
    tracking_no: r.trackingNo,
    validation_no: r.validationNo,
    raw: r.raw,
    events: [...claim.events, ev(r.raw.RtnMsg ?? "建單成功", "created", r.rtnCode)],
  });
  await ctx.store.setOrderFields(tenant.id, order.id, { shipping_tracking: r.trackingNo, shipping_method: choice.label });
  await audit(ctx, tenant.id, "shipment.create", { orderNo: order.order_no, provider: "ecpay", stage: creds.stage, logisticsId: r.logisticsId, retry: opts.retry });
  return { ...shipmentSummary(s, order.order_no), note: `綠界物流單已建立${creds.stage ? "（測試環境，不會真的寄送）" : ""}；訂單會在物流狀態回報「已寄出」後自動轉為已出貨。` };
}

async function adoptShipment(ctx: ServiceContext, tenant: TenantRow, order: OrderRow, claim: ShipmentRow, choice: ShippingChoice, q: Extract<Awaited<ReturnType<typeof queryLogisticsOrder>>, { kind: "found" }>) {
  const s = await ctx.store.updateShipment(tenant.id, claim.id, {
    logistics_id: q.logisticsId,
    tracking_no: q.trackingNo,
    validation_no: q.validationNo,
    raw: { query: q.fields },
    events: [...claim.events, { at: new Date().toISOString(), code: q.status || null, message: "反查綠界：此交易編號已建單，認回（不重建）", status: "created" }],
  });
  await ctx.store.setOrderFields(tenant.id, order.id, { shipping_tracking: q.trackingNo, shipping_method: choice.label });
  await audit(ctx, tenant.id, "shipment.adopt", { orderNo: order.order_no, logisticsId: q.logisticsId });
  return { ...shipmentSummary(s, order.order_no), note: "綠界已經有這張物流單（上次建單其實成功），已認回，不會重複寄件。" };
}

/** M-4：結果不明的出貨單 → 用原 MerchantTradeNo 反查：有 → 認回；確定沒有 → （confirm 後）用同一個交易編號重送；查不到結果 → 不動作 */
async function reconcileUnknownShipment(ctx: ServiceContext, tenant: TenantRow, order: OrderRow, active: ShipmentRow, choice: ShippingChoice, settings: ShippingSettings | null, confirm: boolean | undefined, fetchImpl?: FetchLike) {
  const creds = await ecpayCreds(ctx.store, tenant.id);
  if (!creds) throw new ServiceError("invalid", "此商店尚未設定綠界物流憑證（請平台擁有者到後台「物流」輸入）");
  if (creds.stage !== active.stage) throw new ServiceError("conflict", "綠界帳號環境（測試／正式）已和建單時不同，無法反查這張出貨單，請人工到綠界後台確認");
  const q = await queryLogisticsOrder(creds, active.merchant_trade_no!, fetchImpl);
  if (q.kind === "error") throw new ServiceError("conflict", `無法確認綠界是否已建單（${q.message}），為避免重複寄件這次不重送，請稍後再試`);
  if (q.kind === "found") return adoptShipment(ctx, tenant, order, active, choice, q);
  // 確定不存在
  assertStageAllowed(creds, order);
  if (!settings?.sender) throw new ServiceError("invalid", "請先在 shipping 模組設定寄件人（sender）並發布");
  if (confirm !== true) throw new ServiceError("confirm_required", `綠界查無上次的物流單（交易編號 ${active.merchant_trade_no}），可以用同一個交易編號重送建單${creds.stage ? "（測試環境）" : "，會產生真實寄件與運費"}。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const zip = /^\s*(\d{3,6})/.exec(order.shipping.address)?.[1];
  return sendEcpayCreate(ctx, tenant, order, active, choice, creds, settings, zip, { retry: true }, fetchImpl);
}

export async function getShipment(ctx: ServiceContext, input: { site?: string | null; orderId?: string; orderNo?: string }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShipping(ctx, tenant);
  const order = input.orderId ? await ctx.store.getOrderById(tenant.id, input.orderId) : input.orderNo ? await ctx.store.getOrderByNo(tenant.id, input.orderNo) : null;
  if (!order) throw new ServiceError("not_found", "找不到訂單");
  const r = await ctx.store.listShipments(tenant.id, { orderId: order.id, limit: 10, offset: 0 });
  return { orderNo: order.order_no, shippingChoice: order.shipping_choice, shipments: r.rows.map((s) => shipmentSummary(s, order.order_no)) };
}

export async function listShipments(ctx: ServiceContext, input: { site?: string | null; status?: ShipmentStatus; limit?: number; offset?: number }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShipping(ctx, tenant);
  const r = await ctx.store.listShipments(tenant.id, { status: input.status, limit: Math.max(1, Math.min(100, input.limit ?? 20)), offset: Math.max(0, input.offset ?? 0) });
  const orders = await Promise.all(r.rows.map((s) => ctx.store.getOrderById(tenant.id, s.order_id)));
  return { total: r.total, shipments: r.rows.map((s, i) => shipmentSummary(s, orders[i]?.order_no)) };
}

/**
 * 綠界物流狀態通知。🔴 CheckMacValue（該租戶自己的 HashKey/IV、常數時間比較）不符 → 拒絕（不是 1|OK，綠界會重送）。
 * MerchantID、AllPayLogisticsID 也要跟出貨單相符。狀態只往前走；變成「已寄出」時訂單轉已出貨。
 */
export async function handleLogisticsNotify(deps: { store: Store; sendMail?: ServiceContext["sendMail"]; baseUrl: string }, input: { tenantId: string; rawBody: string }): Promise<{ status: number; body: string; outcome: string }> {
  const params = Object.fromEntries(new URLSearchParams(input.rawBody));
  const creds = await ecpayCreds(deps.store, input.tenantId).catch(() => null);
  if (!creds) return { status: 400, body: "0|NoAccount", outcome: "no_account" };
  if (!verifyCheckMacValue(params, creds.hashKey, creds.hashIv)) {
    console.error(`[ecpay/notify] 🔴 CheckMacValue 不符，拒絕 tenant=${input.tenantId} trade=${params.MerchantTradeNo ?? "-"}`);
    return { status: 400, body: "0|CheckMacValueError", outcome: "bad_mac" };
  }
  if (params.MerchantID !== creds.merchantId) return { status: 400, body: "0|MerchantIDError", outcome: "bad_merchant" };
  const s = params.MerchantTradeNo ? await deps.store.getShipmentByTradeNo(params.MerchantTradeNo) : null;
  if (!s || s.tenant_id !== input.tenantId) {
    console.error(`[ecpay/notify] 找不到出貨單 tenant=${input.tenantId} trade=${params.MerchantTradeNo ?? "-"}`);
    return { status: 200, body: "1|OK", outcome: "unknown_shipment" };
  }
  if (s.logistics_id && params.AllPayLogisticsID && params.AllPayLogisticsID !== s.logistics_id) return { status: 400, body: "0|LogisticsIDError", outcome: "bad_logistics_id" };
  if (creds.stage) {
    const o = await deps.store.getOrderById(s.tenant_id, s.order_id);
    if (!o || (!o.payment_sandbox && !o.shipping_choice?.stage)) {
      console.error(`[ecpay/notify] 🔴 stage 帳號的狀態通知對應到正式訂單，拒絕套用 tenant=${input.tenantId} trade=${params.MerchantTradeNo}`);
      return { status: 400, body: "0|StageAccountNotAllowed", outcome: "stage_rejected" };
    }
  }
  const mapped = mapLogisticsStatus(params.RtnCode ?? "");
  const next = mapped && RANK[mapped] > RANK[s.status] ? mapped : s.status;
  const updated = await deps.store.updateShipment(s.tenant_id, s.id, {
    status: next,
    logistics_id: s.logistics_id ?? params.AllPayLogisticsID ?? null,
    tracking_no: s.tracking_no ?? (params.CVSPaymentNo || params.BookingNote || null),
    events: [...s.events, { at: new Date().toISOString(), code: params.RtnCode ?? null, message: (params.RtnMsg ?? "").slice(0, 200), status: mapped }].slice(-50),
  });
  if (SHIPPED.includes(next)) {
    const tenant = await deps.store.getTenantById(s.tenant_id);
    const order = await deps.store.getOrderById(s.tenant_id, s.order_id);
    if (tenant && order) await markOrderShipped(deps.store, deps.sendMail, deps.baseUrl, tenant, order, updated);
  }
  return { status: 200, body: "1|OK", outcome: `status:${next}` };
}

export { shippingSettings };

/** 儲值訂單（不需出貨）；不 import wallet.ts 以免循環 import */
function isTopupOrder(o: OrderRow): boolean {
  return o.items.some((i) => (i as { item_kind?: string }).item_kind === "topup");
}
