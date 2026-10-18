import type { SiteContent } from "../content";

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

export type OrderStatus = "pending_payment" | "paid" | "fulfilled" | "cancelled";
export type PaymentMethod = "pchomepay" | "offline";

export interface OrderItemInput {
  product_id: string;
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
  tenant_id: string;
  order_id: string;
  stock_deducted: boolean;
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
  created_at: string;
  updated_at: string;
}

export interface PlaceOrderInput {
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
}

export interface PaymentAccountRow {
  id: string;
  tenant_id: string;
  provider: "pchomepay";
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
  provider: "pchomepay";
  gateway_order_no: string;
  amount: number;
  sandbox: boolean;
  status: "pending" | "paid" | "failed" | "paid_after_cancel";
  payment_url: string | null;
  raw: Record<string, unknown> | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Store {
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

  // products
  listProducts(tenantId: string, opts: { status?: "draft" | "published"; limit: number; offset: number }): Promise<{ rows: ProductRow[]; total: number }>;
  getProductById(tenantId: string, id: string): Promise<ProductRow | null>;
  getProductBySlug(tenantId: string, slug: string): Promise<ProductRow | null>;
  getProductsByIds(tenantId: string, ids: string[]): Promise<ProductRow[]>;
  insertProduct(row: Omit<ProductRow, "id" | "created_at" | "updated_at">): Promise<ProductRow>;
  updateProduct(tenantId: string, id: string, patch: Partial<Omit<ProductRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<ProductRow>;
  listVariants(tenantId: string, productIds: string[]): Promise<VariantRow[]>;
  /** 整份取代某商品的規格 */
  replaceVariants(tenantId: string, productId: string, rows: Omit<VariantRow, "id" | "tenant_id" | "product_id" | "created_at">[]): Promise<VariantRow[]>;

  // orders
  /** 原子下單（builder_place_order）：扣庫存＋編號＋寫訂單；庫存不足丟 ServiceError(conflict) 整筆不成立 */
  placeOrder(tenantId: string, order: PlaceOrderInput, items: OrderItemInput[], day: string): Promise<{ id: string; order_no: string }>;
  getOrderById(tenantId: string, id: string): Promise<OrderRow | null>;
  getOrderByNo(tenantId: string, orderNo: string): Promise<OrderRow | null>;
  listOrders(tenantId: string, opts: { status?: OrderStatus; memberId?: string; limit: number; offset: number }): Promise<{ rows: OrderRow[]; total: number }>;
  listOrderItems(tenantId: string, orderId: string): Promise<OrderItemRow[]>;
  /** 條件式轉換：只有目前狀態 = from 才更新；回傳更新後的列，沒轉換成功回 null */
  transitionOrder(tenantId: string, id: string, from: OrderStatus, to: OrderStatus, patch: Partial<Pick<OrderRow, "paid_at" | "fulfilled_at" | "shipping_tracking" | "shipping_method">>): Promise<OrderRow | null>;
  /** 原子取消＋回補庫存（builder_cancel_order） */
  cancelOrder(tenantId: string, id: string, from: OrderStatus[], reason: string): Promise<{ transitioned: boolean; stockReleased: boolean }>;
  /** 冪等回補（builder_release_order_stock） */
  releaseOrderStock(tenantId: string, id: string): Promise<boolean>;
  /** 逾期未付的訂單（所有租戶；cron 用） */
  listExpiredPendingOrders(nowIso: string, limit: number): Promise<Pick<OrderRow, "id" | "tenant_id">[]>;

  // payment accounts & payments
  getPaymentAccount(tenantId: string, provider: "pchomepay"): Promise<PaymentAccountRow | null>;
  upsertPaymentAccount(row: Pick<PaymentAccountRow, "tenant_id" | "provider" | "sandbox" | "app_id" | "secret_enc">): Promise<PaymentAccountRow>;
  markPaymentAccount(tenantId: string, provider: "pchomepay", patch: Pick<PaymentAccountRow, "status" | "verified_at" | "last_error">): Promise<void>;
  insertPayment(row: Pick<PaymentRow, "tenant_id" | "order_id" | "provider" | "gateway_order_no" | "amount" | "sandbox">): Promise<PaymentRow>;
  getPaymentByGatewayNo(gatewayOrderNo: string): Promise<PaymentRow | null>;
  listPaymentsForOrder(tenantId: string, orderId: string): Promise<PaymentRow[]>;
  updatePayment(tenantId: string, id: string, patch: Partial<Pick<PaymentRow, "payment_url" | "raw" | "status" | "paid_at">>): Promise<void>;
  /** 條件式更新付款狀態（目前狀態 = from 才寫）；回傳是否真的轉換 */
  transitionPayment(tenantId: string, id: string, from: PaymentRow["status"], to: PaymentRow["status"], patch: Partial<Pick<PaymentRow, "raw" | "paid_at">>): Promise<boolean>;

  // 原子限流（固定時間窗）
  rateHit(bucket: string, key: string, windowSeconds: number, limit: number): Promise<{ count: number; allowed: boolean }>;

  // audit
  insertAudit(row: Omit<AuditRow, "id" | "at">): Promise<void>;
  listAudit(tenantId: string | null, limit: number): Promise<AuditRow[]>;
}

/** members／shop 相關的 Store 方法（Supabase 與記憶體各自實作） */
export type CommerceStore = Pick<
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
  | "listProducts"
  | "getProductById"
  | "getProductBySlug"
  | "getProductsByIds"
  | "insertProduct"
  | "updateProduct"
  | "listVariants"
  | "replaceVariants"
  | "placeOrder"
  | "getOrderById"
  | "getOrderByNo"
  | "listOrders"
  | "listOrderItems"
  | "transitionOrder"
  | "cancelOrder"
  | "releaseOrderStock"
  | "listExpiredPendingOrders"
  | "getPaymentAccount"
  | "upsertPaymentAccount"
  | "markPaymentAccount"
  | "insertPayment"
  | "getPaymentByGatewayNo"
  | "listPaymentsForOrder"
  | "updatePayment"
  | "transitionPayment"
>;
