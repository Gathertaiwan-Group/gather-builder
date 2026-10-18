import type { SiteContent } from "../content";
import type { ExtStore } from "./types-ext";
import type { ProviderId } from "../pay/types";
import type { PayStore } from "./types-pay";
import type { ClassesStore } from "./types-classes";
import type { ContentStore } from "./types-content";
import type { GroupBuyOrderInput, GroupBuyStore } from "./types-groupbuy";
import type { QrStore } from "./types-qr";
export type * from "./types-ext";
export type * from "./types-classes";
export type * from "./types-content";
export type * from "./types-pay";
export type * from "./types-groupbuy";
export type * from "./types-qr";

export type TenantStatus = "trial" | "active" | "suspended";
export type ModuleStatus = "enabled" | "pending_setup" | "disabled";

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  theme: Record<string, unknown>;
  settings: Record<string, unknown>;
  is_test: boolean;
  published_revision_id: string | null;
  created_at: string;
}

export interface TenantModuleRow {
  tenant_id: string;
  module_id: string;
  status: ModuleStatus;
  config: Record<string, unknown>;
  enabled_at: string | null;
}

export interface DraftRow {
  tenant_id: string;
  content: SiteContent;
  updated_at: string;
  updated_by: string;
  /** 樂觀鎖版本，每次寫入 +1 */
  version: number;
}

export interface RevisionRow {
  id: string;
  tenant_id: string;
  number: number;
  content: SiteContent;
  note: string | null;
  published_by: string;
  published_at: string;
}

export type RevisionSummary = Omit<RevisionRow, "content">;

export interface PostRow {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  cover_url: string | null;
  status: "draft" | "published";
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortfolioRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  image_url: string;
  link_url: string | null;
  tags: string[];
  sort: number;
  status: "draft" | "published";
  created_at: string;
}

export interface InquiryRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  source_path: string | null;
  ip_hash: string | null;
  status: "new" | "read" | "archived";
  created_at: string;
}

export interface TokenRow {
  id: string;
  tenant_id: string | null;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface AuditRow {
  id: number;
  tenant_id: string | null;
  actor: string;
  action: string;
  payload: Record<string, unknown>;
  at: string;
}


/* ------------------------------------------------------------------ members */

export interface MemberRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  name: string | null;
  phone: string | null;
  email_verified_at: string | null;
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
}

export interface MemberSessionRow {
  id: string;
  tenant_id: string;
  member_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip: string | null;
  ua: string | null;
}

export type MemberTokenPurpose = "verify_email" | "reset_password";

export interface MemberTokenRow {
  id: string;
  tenant_id: string;
  member_id: string;
  purpose: MemberTokenPurpose;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ shop */

export interface ProductRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description_md: string;
  images: string[];
  status: "draft" | "published";
  price: number;
  compare_at_price: number | null;
  /** 第八批：品牌（qr-catalog 品牌報表用；可空） */
  brand?: string | null;
  sku: string | null;
  track_inventory: boolean;
  stock: number;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  tenant_id: string;
  product_id: string;
  options: Record<string, string>;
  price: number | null;
  sku: string | null;
  stock: number;
  sort: number;
  created_at: string;
}

export interface VariantWrite {
  options: Record<string, string>;
  price: number | null;
  sku: string | null;
  sort: number;
  /** undefined = 不動（既有規格）／0（新規格） */
  stock?: number;
  expectedStock?: number;
}

export type OrderStatus = "pending_payment" | "paid" | "fulfilled" | "cancelled";
/** credit＝全額由點數折抵／儲值金支付（不經金流，下單即付款成功） */
/** 線上付款＝provider id（第七批：多家金流）；offline 線下匯款；credit 點數／儲值金全額 */
export type PaymentMethod = ProviderId | "offline" | "credit";

export interface OrderItemInput {
  /** 課程類品項（活動票／預約／課程）沒有商品，為 null */
  product_id: string | null;
  variant_id: string | null;
  name: string;
  variant_label: string | null;
  sku: string | null;
  unit_price: number;
  qty: number;
  line_total: number;
}

export interface OrderItemRow extends OrderItemInput {
  id: string;
  /** product（商品）／event_ticket／booking／course */
  item_kind?: "product" | "event_ticket" | "booking" | "course" | "topup";
  /** 課程類品項的票種／服務／課程 id */
  ref_id?: string | null;
  tenant_id: string;
  order_id: string;
  stock_deducted: boolean;
  /** 下單時從哪裡扣庫存（回補只補回同一處） */
  deducted_from: "product" | "variant" | null;
}

export interface OrderContact {
  name: string;
  email: string;
  phone: string;
}
export interface OrderShipping {
  name: string;
  phone: string;
  address: string;
}

export interface OrderRow {
  id: string;
  tenant_id: string;
  order_no: string;
  member_id: string | null;
  contact: OrderContact;
  shipping: OrderShipping;
  items: OrderItemInput[];
  subtotal: number;
  shipping_fee: number;
  total: number;
  status: OrderStatus;
  payment_method: PaymentMethod;
  paid_at: string | null;
  fulfilled_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  expires_at: string | null;
  stock_released_at: string | null;
  access_key_hash: string;
  note: string | null;
  invoice_status: string | null;
  shipping_method: string | null;
  shipping_tracking: string | null;
  /** 付款來自 PChomePay 測試環境（sandbox）：不是真的收到錢，不能出貨 */
  payment_sandbox: boolean;
  discount_total: number;
  coupon_id: string | null;
  coupon_code: string | null;
  referral_code: string | null;
  invoice_request: InvoiceRequest | null;
  shipping_choice: ShippingChoice | null;
  /** 第五批：等級折扣、點數折抵（點數與折抵金額）、儲值金支付。total ＝ 扣掉這些之後要用 payment_method 收的金額 */
  tier_discount?: number;
  points_redeemed?: number;
  points_discount?: number;
  wallet_paid?: number;
  /** 已出貨訂單退款成功的時間（第七批審查 M1；已付款未出貨的退款會直接取消訂單） */
  refunded_at?: string | null;
  /** 第八批：團購單（group-buy）標記團購與團主 */
  group_buy_id?: string | null;
  group_buy_leader_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** 結帳時客人選的發票方式（存在訂單上，開立時使用） */
export type InvoiceRequest =
  | { type: "member" }
  | { type: "mobile"; carrier: string }
  | { type: "certificate"; carrier: string }
  | { type: "donation"; loveCode: string }
  | { type: "b2b"; taxId: string; title: string };

/** 結帳時選的運送方式（server 依店家已發布設定寫入，不信任前端的運費） */
export interface ShippingChoice {
  methodId: string;
  type: "cvs" | "home" | "pickup" | "manual";
  provider: "ecpay" | "manual";
  subType: string | null;
  label: string;
  fee: number;
  store: { id: string; name: string; address: string; outside: boolean } | null;
  cvsSelectionId: string | null;
  /** L-5：下單時用的是綠界測試環境（stage）帳號——只有預覽結帳拿得到；stage 帳號只能處理這種訂單 */
  stage?: boolean;
}

export interface CouponRow {
  id: string;
  tenant_id: string;
  code: string;
  kind: "fixed" | "percent";
  value: number;
  max_discount: number | null;
  min_subtotal: number;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  used_count: number;
  per_user_limit: number | null;
  assigned_member_id: string | null;
  active: boolean;
  source: "manual" | "referral";
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CouponRedemptionRow {
  id: string;
  tenant_id: string;
  coupon_id: string;
  order_id: string;
  user_key: string;
  amount: number;
  created_at: string;
  released_at: string | null;
}

export type PlaceOrderInput = {
  order_prefix: string;
  member_id: string | null;
  contact: OrderContact;
  shipping: OrderShipping;
  subtotal: number;
  shipping_fee: number;
  total: number;
  payment_method: PaymentMethod;
  expires_at: string;
  access_key_hash: string;
  note: string | null;
  discount_total?: number;
  /** 套用的優惠券：在 builder_place_order 同一交易內原子扣總次數與每人次數 */
  coupon?: { id: string; code: string; user_key: string } | null;
  referral_code?: string | null;
  invoice_request?: InvoiceRequest | null;
  shipping_choice?: ShippingChoice | null;
  /** 第八批：團購單——同一交易原子扣團購限量（builder_place_group_buy_order） */
  group_buy?: GroupBuyOrderInput | null;
} & OrderCreditsInput;

/** 下單時的等級折扣／點數折抵／儲值金（builder_apply_order_credits 在下單同一交易原子扣用） */
export interface OrderCreditsInput {
  tier_discount?: number;
  points_redeemed?: number;
  points_discount?: number;
  wallet_paid?: number;
}

export interface PaymentAccountRow {
  id: string;
  tenant_id: string;
  provider: ProviderId;
  sandbox: boolean;
  app_id: string;
  secret_enc: string;
  status: "unverified" | "verified";
  verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  provider: ProviderId;
  gateway_order_no: string;
  /** provider 的交易序號（LINE Pay transactionId 等；字串） */
  gateway_trade_no?: string | null;
  /** LINE Pay confirm 的條件式宣告時間（同一 transactionId 只 confirm 一次） */
  confirm_claimed_at?: string | null;
  confirm_attempts?: number;
  amount: number;
  sandbox: boolean;
  status: "pending" | "paid" | "failed" | "paid_after_cancel" | "refunded";
  payment_url: string | null;
  /** 短網址碼（/p/n/<碼> 等；第七批審查 H1：藍新 MPG 網址上限 200 字） */
  short_code?: string | null;
  /** 導回訂單頁用的存取金鑰（secretbox 加密、AAD 綁租戶） */
  return_key_enc?: string | null;
  raw: Record<string, unknown> | null;
  paid_at: string | null;
  /** 權威回查連續失敗次數（成功回查歸零） */
  query_failures: number;
  last_query_error: string | null;
  /** 已寄出「回查異常」警示給店主的時間（同一筆只寄一次） */
  alerted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Store extends ExtStore, ClassesStore, ContentStore, PayStore, GroupBuyStore, QrStore {
  // tenants
  getTenantBySlug(slug: string): Promise<TenantRow | null>;
  getTenantById(id: string): Promise<TenantRow | null>;
  listTenants(): Promise<TenantRow[]>;
  insertTenant(t: Pick<TenantRow, "slug" | "name" | "status" | "theme" | "settings" | "is_test">): Promise<TenantRow>;
  updateTenant(id: string, patch: Partial<Pick<TenantRow, "name" | "status" | "settings" | "is_test">>): Promise<void>;

  // modules
  listTenantModules(tenantId: string): Promise<TenantModuleRow[]>;
  upsertTenantModule(row: TenantModuleRow): Promise<void>;

  // draft / revisions
  getDraft(tenantId: string): Promise<DraftRow | null>;
  /** 建站時建立第一份草稿（version 1） */
  createDraft(tenantId: string, content: SiteContent, by: string): Promise<void>;
  /** 條件更新：只有目前 version 等於 expectedVersion 才寫入；回傳新 version，衝突回 null */
  saveDraft(tenantId: string, content: SiteContent, by: string, expectedVersion: number): Promise<number | null>;
  /** 原子操作：把 version = expectedDraftVersion 的草稿凍結為下一版並設為已發布；版本不符丟 ServiceError(conflict) */
  publish(tenantId: string, note: string | null, by: string, expectedDraftVersion: number | null): Promise<{ id: string; number: number; draftVersion: number }>;
  /** 原子操作：指定版本設為已發布並覆蓋草稿；版本不存在回 null */
  rollback(tenantId: string, number: number, by: string): Promise<{ id: string; number: number } | null>;
  listRevisions(tenantId: string): Promise<RevisionSummary[]>;
  getRevision(id: string): Promise<RevisionRow | null>;

  // posts
  listPosts(tenantId: string, opts: { status?: "draft" | "published"; limit: number; offset: number; publishedBefore?: string }): Promise<{ rows: PostRow[]; total: number }>;
  getPostBySlug(tenantId: string, slug: string): Promise<PostRow | null>;
  getPostById(tenantId: string, id: string): Promise<PostRow | null>;
  insertPost(row: Omit<PostRow, "id" | "created_at" | "updated_at">): Promise<PostRow>;
  updatePost(tenantId: string, id: string, patch: Partial<Omit<PostRow, "id" | "tenant_id" | "created_at">>): Promise<PostRow>;

  // portfolio
  listPortfolio(tenantId: string, opts: { status?: "draft" | "published"; tag?: string }): Promise<PortfolioRow[]>;
  getPortfolioItem(tenantId: string, id: string): Promise<PortfolioRow | null>;
  insertPortfolioItem(row: Omit<PortfolioRow, "id" | "created_at">): Promise<PortfolioRow>;
  updatePortfolioItem(tenantId: string, id: string, patch: Partial<Omit<PortfolioRow, "id" | "tenant_id" | "created_at">>): Promise<PortfolioRow>;

  // inquiries & line
  insertInquiry(row: Omit<InquiryRow, "id" | "created_at" | "status">): Promise<InquiryRow>;
  listInquiries(tenantId: string, opts: { limit: number; status?: InquiryRow["status"] }): Promise<InquiryRow[]>;
  insertLineClick(row: { tenant_id: string; path: string | null; placement: string | null; ip_hash: string | null; user_agent: string | null }): Promise<void>;
  countLineClicks(tenantId: string): Promise<number>;

  // tokens
  insertToken(row: Omit<TokenRow, "id" | "created_at" | "last_used_at" | "revoked_at">): Promise<TokenRow>;
  findTokenByHash(hash: string): Promise<TokenRow | null>;
  touchToken(id: string): Promise<void>;
  revokeToken(id: string): Promise<TokenRow | null>;
  listTokens(tenantId: string | null | "all"): Promise<TokenRow[]>;
  getToken(id: string): Promise<TokenRow | null>;

  // members（每個查詢都帶 tenant_id：A 站的資料在 B 站查不到）
  /** email 已存在（同租戶）回 null */
  insertMember(row: Pick<MemberRow, "tenant_id" | "email" | "password_hash" | "name" | "phone">): Promise<MemberRow | null>;
  getMemberByEmail(tenantId: string, email: string): Promise<MemberRow | null>;
  getMemberById(tenantId: string, id: string): Promise<MemberRow | null>;
  updateMember(tenantId: string, id: string, patch: Partial<Pick<MemberRow, "password_hash" | "name" | "phone" | "email_verified_at" | "status" | "last_login_at">>): Promise<MemberRow | null>;
  listMembers(tenantId: string, opts: { limit: number; offset: number; q?: string }): Promise<{ rows: MemberRow[]; total: number }>;
  insertMemberSession(row: Omit<MemberSessionRow, "id" | "created_at" | "revoked_at">): Promise<MemberSessionRow>;
  getMemberSessionByHash(tokenHash: string): Promise<MemberSessionRow | null>;
  revokeMemberSession(tenantId: string, id: string): Promise<void>;
  /** 撤銷該會員所有未撤銷的 session，回傳撤銷筆數 */
  revokeAllMemberSessions(tenantId: string, memberId: string): Promise<number>;
  insertMemberToken(row: Omit<MemberTokenRow, "id" | "created_at" | "used_at">): Promise<void>;
  /** 一次性消耗：條件更新（未使用、未過期、用途相符）成功才回傳該列；否則 null */
  consumeMemberToken(tenantId: string, tokenHash: string, purpose: MemberTokenPurpose, nowIso: string): Promise<MemberTokenRow | null>;
  /** 讓該會員某用途所有未使用的 token 失效（重設成功後用） */
  invalidateMemberTokens(tenantId: string, memberId: string, purpose: MemberTokenPurpose): Promise<void>;

  // products
  listProducts(tenantId: string, opts: { status?: "draft" | "published"; limit: number; offset: number }): Promise<{ rows: ProductRow[]; total: number }>;
  getProductById(tenantId: string, id: string): Promise<ProductRow | null>;
  getProductBySlug(tenantId: string, slug: string): Promise<ProductRow | null>;
  getProductsByIds(tenantId: string, ids: string[]): Promise<ProductRow[]>;
  insertProduct(row: Omit<ProductRow, "id" | "created_at" | "updated_at">): Promise<ProductRow>;
  updateProduct(tenantId: string, id: string, patch: Partial<Omit<ProductRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<ProductRow>;
  listVariants(tenantId: string, productIds: string[]): Promise<VariantRow[]>;
  /** 整份取代某商品的規格：options 相同的沿用原本的列（id 不變、只更新價格／SKU／庫存），其餘新增，多出的刪除 */
  /**
   * 整份取代規格清單（patch 語意）：stock 沒帶（undefined）的既有規格保留原庫存、新規格為 0；
   * 帶 expectedStock 時以條件更新（目前庫存 = expectedStock 才寫），不符丟 ServiceError(conflict)。
   */
  replaceVariants(tenantId: string, productId: string, rows: VariantWrite[]): Promise<VariantRow[]>;
  /** 條件式改商品庫存：目前庫存 = expected 才寫；回傳是否成功 */
  setProductStockIf(tenantId: string, id: string, expected: number, next: number): Promise<boolean>;

  // orders
  /** 原子下單（builder_place_order）：扣庫存＋編號＋寫訂單；庫存不足丟 ServiceError(conflict) 整筆不成立 */
  placeOrder(tenantId: string, order: PlaceOrderInput, items: OrderItemInput[], day: string): Promise<{ id: string; order_no: string }>;
  getOrderById(tenantId: string, id: string): Promise<OrderRow | null>;
  getOrderByNo(tenantId: string, orderNo: string): Promise<OrderRow | null>;
  listOrders(tenantId: string, opts: { status?: OrderStatus; memberId?: string; groupBuyId?: string; leaderId?: string; groupBuyOnly?: boolean; limit: number; offset: number }): Promise<{ rows: OrderRow[]; total: number }>;
  listOrderItems(tenantId: string, orderId: string): Promise<OrderItemRow[]>;
  /** 條件式轉換：只有目前狀態 = from 才更新；回傳更新後的列，沒轉換成功回 null */
  transitionOrder(tenantId: string, id: string, from: OrderStatus, to: OrderStatus, patch: Partial<Pick<OrderRow, "paid_at" | "fulfilled_at" | "shipping_tracking" | "shipping_method" | "payment_sandbox">>): Promise<OrderRow | null>;
  /** 第七批審查 M1：已出貨訂單退款成功 → refunded_at（只成功一次）＋同交易退回點數折抵／儲值金（builder_mark_order_refunded）；沒標記回 null */
  markOrderRefunded(tenantId: string, id: string): Promise<OrderRow | null>;
  /** M3：sandbox 付款成功 → 同一交易轉 paid（payment_sandbox）＋釋放報名／預約保留（builder_mark_paid_sandbox）；沒轉換回 null */
  markPaidSandbox(tenantId: string, id: string, paidAt: string): Promise<OrderRow | null>;
  /** 原子取消＋回補庫存（builder_cancel_order） */
  cancelOrder(tenantId: string, id: string, from: OrderStatus[], reason: string): Promise<{ transitioned: boolean; stockReleased: boolean }>;
  /** 冪等回補（builder_release_order_stock） */
  releaseOrderStock(tenantId: string, id: string): Promise<boolean>;
  /** 逾期未付的訂單（所有租戶；cron 用） */
  listExpiredPendingOrders(nowIso: string, limit: number): Promise<Pick<OrderRow, "id" | "tenant_id">[]>;
  /** 某租戶含指定商品、已逾期未付的訂單（下單前先釋放逾期保留用） */
  listExpiredPendingOrdersForProducts(tenantId: string, productIds: string[], nowIso: string, limit: number): Promise<OrderRow[]>;

  // payment accounts & payments
  getPaymentAccount(tenantId: string, provider: ProviderId): Promise<PaymentAccountRow | null>;
  listPaymentAccounts(tenantId: string): Promise<PaymentAccountRow[]>;
  upsertPaymentAccount(row: Pick<PaymentAccountRow, "tenant_id" | "provider" | "sandbox" | "app_id" | "secret_enc">): Promise<PaymentAccountRow>;
  markPaymentAccount(tenantId: string, provider: ProviderId, patch: Pick<PaymentAccountRow, "status" | "verified_at" | "last_error">): Promise<void>;
  insertPayment(row: Pick<PaymentRow, "tenant_id" | "order_id" | "provider" | "gateway_order_no" | "amount" | "sandbox"> & Partial<Pick<PaymentRow, "short_code" | "return_key_enc">>): Promise<PaymentRow>;
  getPaymentByGatewayNo(gatewayOrderNo: string): Promise<PaymentRow | null>;
  /** 短網址碼查付款（跨租戶；呼叫端再比對租戶） */
  getPaymentByShortCode(code: string): Promise<PaymentRow | null>;
  listPaymentsForOrder(tenantId: string, orderId: string): Promise<PaymentRow[]>;
  updatePayment(tenantId: string, id: string, patch: Partial<Pick<PaymentRow, "payment_url" | "raw" | "status" | "paid_at" | "query_failures" | "last_query_error" | "gateway_trade_no" | "confirm_claimed_at">>): Promise<void>;
  /** LINE Pay：條件式宣告 confirm（confirm_claimed_at 為 null 或早於 staleBeforeIso、且付款仍 pending 才成功；attempts＋1） */
  claimPaymentConfirm(tenantId: string, id: string, staleBeforeIso: string): Promise<boolean>;
  /** 回查失敗次數 +1（原子），回傳新的次數 */
  bumpPaymentQueryFailure(tenantId: string, id: string, error: string): Promise<number>;
  /** 條件式標記已警示（alerted_at 由 null 改成 now 的那一次回 true） */
  markPaymentAlerted(tenantId: string, id: string): Promise<boolean>;
  /** 條件式更新付款狀態（目前狀態 = from 才寫）；回傳是否真的轉換 */
  transitionPayment(tenantId: string, id: string, from: PaymentRow["status"], to: PaymentRow["status"], patch: Partial<Pick<PaymentRow, "raw" | "paid_at">>): Promise<boolean>;

  // coupons（扣用在 placeOrder 的同一交易；回補在 cancelOrder 的同一交易）
  /** code 重複丟 ServiceError(conflict) */
  insertCoupon(row: Omit<CouponRow, "id" | "created_at" | "updated_at" | "used_count">): Promise<CouponRow>;
  updateCoupon(tenantId: string, id: string, patch: Partial<Pick<CouponRow, "active" | "ends_at" | "max_uses" | "per_user_limit" | "note" | "min_subtotal">>): Promise<CouponRow | null>;
  getCouponByCode(tenantId: string, code: string): Promise<CouponRow | null>;
  getCouponById(tenantId: string, id: string): Promise<CouponRow | null>;
  listCoupons(tenantId: string, opts: { active?: boolean; limit: number; offset: number }): Promise<{ rows: CouponRow[]; total: number }>;
  getCouponUserCount(couponId: string, userKey: string): Promise<number>;
  getRedemptionByOrder(tenantId: string, orderId: string): Promise<CouponRedemptionRow | null>;
  /** 冪等回補（builder_release_coupon） */
  releaseCoupon(tenantId: string, orderId: string): Promise<boolean>;

  // 原子限流（固定時間窗）
  rateHit(bucket: string, key: string, windowSeconds: number, limit: number): Promise<{ count: number; allowed: boolean }>;
  /** 以數量累計的原子額度（builder_quota_take）：累計 + amount ≤ limit 才扣並回 allowed */
  quotaTake(bucket: string, key: string, windowStartIso: string, amount: number, limit: number): Promise<{ total: number; allowed: boolean }>;

  // audit
  insertAudit(row: Omit<AuditRow, "id" | "at">): Promise<void>;
  listAudit(tenantId: string | null, limit: number): Promise<AuditRow[]>;
}

/** 需要碰訂單表、所以跟 commerce 實作放在一起的 ext 方法 */
export type OrderLinkedExt = "setOrderFields" | "countPaidOrdersFor";

/** members／shop 相關的 Store 方法（Supabase 與記憶體各自實作） */
export type CommerceStore = Pick<Store, OrderLinkedExt> & Pick<
  Store,
  | "insertMember"
  | "getMemberByEmail"
  | "getMemberById"
  | "updateMember"
  | "listMembers"
  | "insertMemberSession"
  | "getMemberSessionByHash"
  | "revokeMemberSession"
  | "revokeAllMemberSessions"
  | "insertMemberToken"
  | "consumeMemberToken"
  | "invalidateMemberTokens"
  | "listProducts"
  | "getProductById"
  | "getProductBySlug"
  | "getProductsByIds"
  | "insertProduct"
  | "updateProduct"
  | "listVariants"
  | "replaceVariants"
  | "setProductStockIf"
  | "placeOrder"
  | "getOrderById"
  | "getOrderByNo"
  | "listOrders"
  | "listOrderItems"
  | "transitionOrder"
  | "markOrderRefunded"
  | "getPaymentByShortCode"
  | "cancelOrder"
  | "markPaidSandbox"
  | "releaseOrderStock"
  | "listExpiredPendingOrders"
  | "listExpiredPendingOrdersForProducts"
  | "bumpPaymentQueryFailure"
  | "markPaymentAlerted"
  | "getPaymentAccount"
  | "listPaymentAccounts"
  | "claimPaymentConfirm"
  | "upsertPaymentAccount"
  | "markPaymentAccount"
  | "insertPayment"
  | "getPaymentByGatewayNo"
  | "listPaymentsForOrder"
  | "updatePayment"
  | "transitionPayment"
  | "insertCoupon"
  | "updateCoupon"
  | "getCouponByCode"
  | "getCouponById"
  | "listCoupons"
  | "getCouponUserCount"
  | "getRedemptionByOrder"
  | "releaseCoupon"
>;
