/**
 * 第三批模組（invoice／shipping／referral／newsletter／ai-chat）的資料列與 Store 方法。
 * coupons 因為要跟下單同一個原子交易，方法放在 CommerceStore（types.ts）。
 * 每個查詢都帶 tenant_id：A 站的資料在 B 站查不到。
 */

/* ------------------------------------------------------------------ invoice */

export type InvoiceProviderId = "amego" | "mock";
export type InvoiceStatus = "pending" | "issuing" | "issued" | "failed" | "voided" | "allowance";

export interface InvoiceAccountRow {
  id: string;
  tenant_id: string;
  provider: InvoiceProviderId;
  /** 賣方統編 */
  seller_tax_id: string;
  /** AES-256-GCM 密文（Amego app key），AAD 綁 tenant_id */
  secret_enc: string;
  status: "unverified" | "verified";
  verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  order_id: string;
  provider: InvoiceProviderId;
  status: InvoiceStatus;
  amount: number;
  invoice_no: string | null;
  random_number: string | null;
  /** 開立日期 YYYYMMDD（台北），作廢／折讓判斷跨期用 */
  invoice_date: string | null;
  raw: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  claimed_at: string | null;
  issued_at: string | null;
  voided_at: string | null;
  allowance_no: string | null;
  allowance_amount: number | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ shipping */

export interface ShippingAccountRow {
  id: string;
  tenant_id: string;
  provider: "ecpay";
  merchant_id: string;
  /** JSON {hashKey, hashIv} 的密文 */
  secret_enc: string;
  /** true = 綠界測試環境（logistics-stage） */
  stage: boolean;
  /** 綠界物流申請類型：C2C（店到店）或 B2C（大宗寄倉＋宅配） */
  kind: "C2C" | "B2C";
  status: "unverified" | "verified";
  verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CvsStore {
  id: string;
  name: string;
  address: string;
  outside: boolean;
}

export interface CvsSelectionRow {
  id: string;
  tenant_id: string;
  /** 送給綠界的 MerchantTradeNo 的 sha256（原文只在瀏覽器與綠界之間） */
  trade_no_hash: string;
  /** 綁定這次結帳的瀏覽器 cookie 秘密的 sha256 */
  binding_hash: string;
  sub_type: string;
  method_id: string;
  store: CvsStore | null;
  selected_at: string | null;
  expires_at: string;
  used_at: string | null;
  order_id: string | null;
  created_at: string;
}

export type ShipmentStatus = "created" | "in_transit" | "arrived" | "delivered" | "returned" | "failed" | "cancelled";

export interface ShipmentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  method_id: string;
  method_type: "cvs" | "home" | "pickup" | "manual";
  provider: "ecpay" | "manual";
  sub_type: string | null;
  /** 送給綠界的 MerchantTradeNo（綠界通知回來用它對應） */
  merchant_trade_no: string | null;
  logistics_id: string | null;
  store: CvsStore | null;
  tracking_no: string | null;
  validation_no: string | null;
  status: ShipmentStatus;
  stage: boolean;
  raw: Record<string, unknown> | null;
  events: { at: string; code: string | null; message: string | null; status: ShipmentStatus | null }[];
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ referral */

export interface ReferralCodeRow {
  id: string;
  tenant_id: string;
  member_id: string;
  code: string;
  /** KOL 分潤比例（萬分比，0 = 不分潤；例如 500 = 5%） */
  kol_rate_bp: number;
  created_at: string;
}

export interface ReferralRow {
  id: string;
  tenant_id: string;
  referrer_member_id: string;
  /** 被推薦人識別：member:<id> 或 email:<email>（同一人只觸發一次） */
  referee_key: string;
  referee_member_id: string | null;
  order_id: string;
  reward_coupon_id: string | null;
  created_at: string;
}

export interface ReferralLedgerRow {
  id: number;
  tenant_id: string;
  referrer_member_id: string;
  order_id: string;
  kind: "earn" | "reverse";
  amount: number;
  created_at: string;
}

/* ------------------------------------------------------------------ newsletter */

export interface SubscriberRow {
  id: string;
  tenant_id: string;
  email: string;
  status: "pending" | "confirmed" | "unsubscribed";
  confirm_token_hash: string | null;
  confirm_expires_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
}

export interface BroadcastRow {
  id: string;
  tenant_id: string;
  subject: string;
  body_md: string;
  status: "draft" | "sending" | "sent";
  test_sent_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  sent_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  tenant_id: string;
  broadcast_id: string;
  subscriber_id: string;
  email: string;
  unsub_token_hash: string;
  status: "queued" | "sent" | "failed" | "skipped";
  error: string | null;
  sent_at: string | null;
  unsub_used_at: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ ai-chat */

export interface AiChatMessage {
  role: "user" | "model";
  text: string;
  at: string;
}

export interface AiChatRow {
  id: string;
  tenant_id: string;
  session_id: string;
  ip_hash: string | null;
  messages: AiChatMessage[];
  lead_inquiry_id: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ Store 方法 */

export interface ExtStore {
  // invoice
  getInvoiceAccount(tenantId: string): Promise<InvoiceAccountRow | null>;
  upsertInvoiceAccount(row: Pick<InvoiceAccountRow, "tenant_id" | "provider" | "seller_tax_id" | "secret_enc">): Promise<InvoiceAccountRow>;
  markInvoiceAccount(tenantId: string, patch: Pick<InvoiceAccountRow, "status" | "verified_at" | "last_error">): Promise<void>;
  /** 建立發票列（order_id 唯一）：已存在回 { created: false } 與既有列 */
  ensureInvoice(row: Pick<InvoiceRow, "tenant_id" | "order_id" | "provider" | "amount">): Promise<{ row: InvoiceRow; created: boolean }>;
  getInvoiceByOrder(tenantId: string, orderId: string): Promise<InvoiceRow | null>;
  /**
   * 條件式宣告開立（claim-then-act）：pending／failed，或 issuing 但 claimed_at 早於 staleBeforeIso → issuing、attempts+1。
   * 併發只有一個拿得到列。
   */
  claimInvoice(tenantId: string, id: string, staleBeforeIso: string): Promise<InvoiceRow | null>;
  /** 條件式更新（目前狀態 ∈ from 才寫），回傳更新後的列 */
  updateInvoice(tenantId: string, id: string, from: InvoiceStatus[], patch: Partial<Omit<InvoiceRow, "id" | "tenant_id" | "order_id" | "created_at">>): Promise<InvoiceRow | null>;
  listInvoices(tenantId: string, opts: { status?: InvoiceStatus; limit: number; offset: number }): Promise<{ rows: InvoiceRow[]; total: number }>;
  /** 所有租戶待重試的發票（cron 用） */
  listInvoicesToRetry(limit: number, maxAttempts: number): Promise<Pick<InvoiceRow, "id" | "tenant_id" | "order_id">[]>;
  /** 訂單同步欄位（發票狀態、物流方式、追蹤號） */
  setOrderFields(tenantId: string, orderId: string, patch: { invoice_status?: string | null; shipping_method?: string | null; shipping_tracking?: string | null }): Promise<void>;

  // shipping
  getShippingAccount(tenantId: string): Promise<ShippingAccountRow | null>;
  upsertShippingAccount(row: Pick<ShippingAccountRow, "tenant_id" | "provider" | "merchant_id" | "secret_enc" | "stage" | "kind">): Promise<ShippingAccountRow>;
  markShippingAccount(tenantId: string, patch: Pick<ShippingAccountRow, "status" | "verified_at" | "last_error">): Promise<void>;
  insertCvsSelection(row: Pick<CvsSelectionRow, "tenant_id" | "trade_no_hash" | "binding_hash" | "sub_type" | "method_id" | "expires_at">): Promise<CvsSelectionRow>;
  /** 綠界電子地圖 callback 寫回門市：只寫「未使用、未過期、子類型相符」的那一列；回傳是否寫入 */
  setCvsSelectionStore(tradeNoHash: string, subType: string, store: CvsStore, nowIso: string): Promise<CvsSelectionRow | null>;
  getCvsSelection(tenantId: string, id: string): Promise<CvsSelectionRow | null>;
  /** 原子消耗：同租戶、binding 相符、已選門市、未使用、未過期 → used_at、order_id */
  consumeCvsSelection(tenantId: string, id: string, bindingHash: string, nowIso: string): Promise<CvsSelectionRow | null>;
  attachCvsSelectionOrder(tenantId: string, id: string, orderId: string): Promise<void>;
  /** 下單失敗時歸還（used_at 清空） */
  releaseCvsSelection(tenantId: string, id: string): Promise<void>;
  /** 同一訂單只能有一張有效出貨單（failed／cancelled 以外）；違反丟 conflict */
  insertShipment(row: Omit<ShipmentRow, "id" | "created_at" | "updated_at" | "events"> & { events?: ShipmentRow["events"] }): Promise<ShipmentRow>;
  getShipmentById(tenantId: string, id: string): Promise<ShipmentRow | null>;
  getActiveShipmentByOrder(tenantId: string, orderId: string): Promise<ShipmentRow | null>;
  getShipmentByTradeNo(merchantTradeNo: string): Promise<ShipmentRow | null>;
  updateShipment(tenantId: string, id: string, patch: Partial<Pick<ShipmentRow, "status" | "logistics_id" | "tracking_no" | "validation_no" | "raw" | "events">>): Promise<ShipmentRow>;
  listShipments(tenantId: string, opts: { status?: ShipmentStatus; orderId?: string; limit: number; offset: number }): Promise<{ rows: ShipmentRow[]; total: number }>;

  // referral
  getReferralCodeByMember(tenantId: string, memberId: string): Promise<ReferralCodeRow | null>;
  getReferralCodeByCode(tenantId: string, code: string): Promise<ReferralCodeRow | null>;
  /** code 或 member 重複回 null */
  insertReferralCode(row: Pick<ReferralCodeRow, "tenant_id" | "member_id" | "code">): Promise<ReferralCodeRow | null>;
  updateReferralCode(tenantId: string, id: string, patch: Pick<ReferralCodeRow, "kol_rate_bp">): Promise<ReferralCodeRow | null>;
  /** 同一被推薦人只會成功一次（unique tenant_id+referee_key）；重複回 null */
  insertReferral(row: Omit<ReferralRow, "id" | "created_at" | "reward_coupon_id">): Promise<ReferralRow | null>;
  setReferralReward(tenantId: string, id: string, couponId: string): Promise<void>;
  listReferrals(tenantId: string, opts: { referrerMemberId?: string; limit: number; offset: number }): Promise<{ rows: ReferralRow[]; total: number }>;
  /** 只增不改的分潤帳：同一訂單同一 kind 只會寫一次（unique order_id+kind），重複回 false */
  insertLedger(row: Omit<ReferralLedgerRow, "id" | "created_at">): Promise<boolean>;
  listLedger(tenantId: string, opts: { referrerMemberId?: string; orderId?: string; limit: number }): Promise<ReferralLedgerRow[]>;
  /** 某人（會員或 email）在這個網站已付款（paid／fulfilled）的訂單數，不含 excludeOrderId */
  countPaidOrdersFor(tenantId: string, who: { memberId: string | null; email: string }, excludeOrderId: string): Promise<number>;

  // newsletter
  /** 新訂閱或重新訂閱（unsubscribed → pending）；已確認的不變。回傳列與是否需要寄確認信 */
  upsertPendingSubscriber(row: Pick<SubscriberRow, "tenant_id" | "email" | "confirm_token_hash" | "confirm_expires_at">): Promise<{ row: SubscriberRow; needsConfirm: boolean }>;
  /** 一次性確認：token 相符、未過期、狀態 pending → confirmed（token 清掉） */
  confirmSubscriber(tenantId: string, tokenHash: string, nowIso: string): Promise<SubscriberRow | null>;
  getSubscriberById(tenantId: string, id: string): Promise<SubscriberRow | null>;
  unsubscribeSubscriber(tenantId: string, id: string): Promise<boolean>;
  listSubscribers(tenantId: string, opts: { status?: SubscriberRow["status"]; limit: number; offset: number }): Promise<{ rows: SubscriberRow[]; total: number }>;
  insertBroadcast(row: Pick<BroadcastRow, "tenant_id" | "subject" | "body_md">): Promise<BroadcastRow>;
  getBroadcast(tenantId: string, id: string): Promise<BroadcastRow | null>;
  /** 條件式更新（目前狀態 ∈ from 才寫） */
  updateBroadcast(tenantId: string, id: string, from: BroadcastRow["status"][], patch: Partial<Omit<BroadcastRow, "id" | "tenant_id" | "created_at">>): Promise<BroadcastRow | null>;
  listBroadcasts(tenantId: string, limit: number): Promise<BroadcastRow[]>;
  /** 為所有「已確認」的訂閱者建立寄送列（broadcast_id+subscriber_id 唯一，重複略過）；回傳新增數 */
  queueDeliveries(tenantId: string, broadcastId: string, tokenFor: (subscriberId: string) => string): Promise<number>;
  listQueuedDeliveries(tenantId: string, broadcastId: string, limit: number): Promise<DeliveryRow[]>;
  /** 條件式更新寄送列（queued → sent／failed／skipped），回傳是否真的轉換 */
  finishDelivery(tenantId: string, id: string, patch: Pick<DeliveryRow, "status" | "error" | "sent_at">): Promise<boolean>;
  /** 一次性退訂 token：unsub_used_at 由 null 改成 now 的那一次回列 */
  consumeUnsubToken(tenantId: string, tokenHash: string): Promise<DeliveryRow | null>;
  deliveryStats(tenantId: string, broadcastId: string): Promise<Record<DeliveryRow["status"], number>>;

  // ai-chat
  getAiChat(tenantId: string, sessionId: string): Promise<AiChatRow | null>;
  saveAiChat(row: Pick<AiChatRow, "tenant_id" | "session_id" | "ip_hash" | "messages" | "lead_inquiry_id">): Promise<AiChatRow>;
  listAiChats(tenantId: string, limit: number): Promise<AiChatRow[]>;
}
