/** 第九批「平台化」：自有網域、店主帳號、平台訂單、MCP OAuth 的資料列與 Store 介面 */

export type DomainStatus = "pending" | "verified" | "active";

export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  name: string;
  value: string;
  reason?: string;
}

export interface TenantDomainRow {
  id: string;
  tenant_id: string;
  domain: string;
  status: DomainStatus;
  verify_method: "vercel";
  dns_records: DnsRecord[];
  last_checked_at: string | null;
  last_error: string | null;
  verified_at: string | null;
  activated_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DomainStore {
  insertTenantDomain(row: Pick<TenantDomainRow, "tenant_id" | "domain" | "dns_records" | "created_by">): Promise<TenantDomainRow>;
  listTenantDomains(tenantId: string): Promise<TenantDomainRow[]>;
  getTenantDomain(tenantId: string, id: string): Promise<TenantDomainRow | null>;
  getDomainByName(domain: string): Promise<TenantDomainRow | null>;
  /** 條件式更新：from 有給時只在目前狀態屬於 from 才更新 */
  updateTenantDomain(tenantId: string, id: string, patch: Partial<Pick<TenantDomainRow, "status" | "dns_records" | "last_checked_at" | "last_error" | "verified_at">>, from?: DomainStatus[]): Promise<TenantDomainRow | null>;
  /** 單一交易：其他 active 降為 verified、這個轉 active、租戶 primary_domain＝這個網域 */
  activateTenantDomain(tenantId: string, id: string): Promise<string>;
  /** 刪除網域；是 active 的話一併清掉租戶 primary_domain */
  deleteTenantDomain(tenantId: string, id: string): Promise<boolean>;
  listPendingDomains(limit: number): Promise<TenantDomainRow[]>;
}

/* ------------------------------------------------------------------ 店主帳號 */

export type TenantRole = "owner" | "editor" | "viewer";

export interface OwnerUserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  status: "active" | "disabled";
  totp_secret_enc: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TenantUserRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  status: "invited" | "active" | "disabled";
  invited_by: string;
  created_at: string;
  updated_at: string;
}

export interface OwnerSessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export type OwnerTokenPurpose = "invite" | "reset" | "mfa";
export interface OwnerTokenRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  purpose: OwnerTokenPurpose;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface OwnerStore {
  insertOwnerUser(row: Pick<OwnerUserRow, "email" | "name" | "password_hash">): Promise<OwnerUserRow>;
  getOwnerUserByEmail(email: string): Promise<OwnerUserRow | null>;
  getOwnerUserById(id: string): Promise<OwnerUserRow | null>;
  updateOwnerUser(id: string, patch: Partial<Pick<OwnerUserRow, "name" | "password_hash" | "status" | "totp_secret_enc" | "totp_enabled_at" | "last_login_at">>): Promise<OwnerUserRow | null>;
  /** 條件式：totp_last_step 為 null 或小於 step 才寫入（同一組碼只能用一次） */
  claimTotpStep(userId: string, step: number): Promise<boolean>;
  insertTenantUser(row: Pick<TenantUserRow, "tenant_id" | "user_id" | "role" | "status" | "invited_by">): Promise<TenantUserRow>;
  getTenantUser(tenantId: string, userId: string): Promise<TenantUserRow | null>;
  getTenantUserById(tenantId: string, id: string): Promise<TenantUserRow | null>;
  listTenantUsers(tenantId: string): Promise<TenantUserRow[]>;
  listUserMemberships(userId: string): Promise<TenantUserRow[]>;
  updateTenantUser(tenantId: string, id: string, patch: Partial<Pick<TenantUserRow, "role" | "status">>): Promise<TenantUserRow | null>;
  insertOwnerSession(row: Pick<OwnerSessionRow, "user_id" | "token_hash" | "ip_hash" | "user_agent" | "expires_at">): Promise<OwnerSessionRow>;
  getOwnerSessionByHash(hash: string): Promise<OwnerSessionRow | null>;
  touchOwnerSession(id: string, nowIso: string): Promise<void>;
  revokeOwnerSession(id: string): Promise<void>;
  revokeOwnerSessionsForUser(userId: string): Promise<number>;
  insertOwnerToken(row: Pick<OwnerTokenRow, "user_id" | "tenant_id" | "purpose" | "token_hash" | "expires_at">): Promise<void>;
  /** 只讀（不消耗）：未使用、未過期、用途相符的 token（二步驟登入輸錯碼時不讓 ticket 失效） */
  peekOwnerToken(hash: string, purpose: OwnerTokenPurpose, nowIso: string): Promise<OwnerTokenRow | null>;
  /** 原子：未使用、未過期、用途相符才標 used_at 並回傳 */
  consumeOwnerToken(hash: string, purpose: OwnerTokenPurpose, nowIso: string): Promise<OwnerTokenRow | null>;
  invalidateOwnerTokens(userId: string, purpose: OwnerTokenPurpose): Promise<void>;
}

/* ------------------------------------------------------------------ 平台訂單與月費 */

export type PlatformOrderKind = "new_site" | "add_modules" | "renewal";
export type PlatformOrderStatus = "pending_payment" | "paid" | "expired" | "cancelled";
export type ProvisionState = "none" | "provisioning" | "done" | "failed";

export interface PlatformOrderRow {
  id: string;
  order_no: string;
  kind: PlatformOrderKind;
  tenant_id: string | null;
  slug: string | null;
  brand_name: string | null;
  theme_preset: string | null;
  contact_email: string;
  modules: string[];
  amount_setup: number;
  amount_monthly: number;
  amount_total: number;
  period_start: string | null;
  period_end: string | null;
  status: PlatformOrderStatus;
  sandbox: boolean;
  is_test: boolean;
  access_key_hash: string;
  gateway_order_no: string | null;
  payment_url: string | null;
  paid_at: string | null;
  paid_amount: number | null;
  query_failures: number;
  provision_state: ProvisionState;
  provision_claimed_at: string | null;
  provision_attempts: number;
  provision_error: string | null;
  provisioned_at: string | null;
  alerted_at: string | null;
  expires_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type PlatformOrderInsert = Pick<PlatformOrderRow, "order_no" | "kind" | "tenant_id" | "slug" | "brand_name" | "theme_preset" | "contact_email" | "modules" | "amount_setup" | "amount_monthly" | "amount_total" | "period_start" | "period_end" | "sandbox" | "is_test" | "access_key_hash" | "expires_at" | "created_by">;
export type PlatformOrderPatch = Partial<Pick<PlatformOrderRow, "access_key_hash" | "status" | "gateway_order_no" | "payment_url" | "paid_at" | "paid_amount" | "query_failures" | "provision_state" | "provision_error" | "provisioned_at" | "alerted_at" | "tenant_id" | "expires_at">>;

export interface TenantBillingRow {
  tenant_id: string;
  modules: string[];
  monthly_amount: number;
  status: "active" | "past_due" | "suspended" | "cancelled";
  paid_until: string;
  grace_until: string | null;
  cancel_at_period_end: boolean;
  suspended_at: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlatformBillingStore {
  insertPlatformOrder(row: PlatformOrderInsert): Promise<PlatformOrderRow>;
  getPlatformOrderById(id: string): Promise<PlatformOrderRow | null>;
  getPlatformOrderByNo(orderNo: string): Promise<PlatformOrderRow | null>;
  getPlatformOrderByGatewayNo(gatewayOrderNo: string): Promise<PlatformOrderRow | null>;
  /** 條件式更新：where 的每個欄位都要相符（status 可給陣列；gatewayIsNull＝gateway_order_no 必須為 null） */
  updatePlatformOrder(id: string, patch: PlatformOrderPatch, where?: { status?: PlatformOrderStatus[]; provision_state?: ProvisionState[]; gatewayIsNull?: boolean; alertedIsNull?: boolean }): Promise<PlatformOrderRow | null>;
  /** 宣告開站／開通（已付款且 none／failed，或 provisioning 超過 staleBefore）：attempts+1、state=provisioning；同時只會有一個成功 */
  claimPlatformProvision(id: string, staleBeforeIso: string): Promise<PlatformOrderRow | null>;
  listPlatformOrders(opts: { tenantId?: string; status?: PlatformOrderStatus[]; kind?: PlatformOrderKind; limit: number }): Promise<PlatformOrderRow[]>;
  /** cron：逾期的待付款單＋還沒開好站的已付款單 */
  listPlatformOrdersForSweep(nowIso: string, staleBeforeIso: string, limit: number): Promise<PlatformOrderRow[]>;
  getTenantBilling(tenantId: string): Promise<TenantBillingRow | null>;
  insertTenantBilling(row: Pick<TenantBillingRow, "tenant_id" | "modules" | "monthly_amount" | "paid_until" | "is_test">): Promise<TenantBillingRow | null>;
  updateTenantBilling(tenantId: string, patch: Partial<Pick<TenantBillingRow, "modules" | "monthly_amount" | "status" | "paid_until" | "grace_until" | "cancel_at_period_end" | "suspended_at">>, whereStatus?: TenantBillingRow["status"][]): Promise<TenantBillingRow | null>;
  /** paid_until 早於 horizon 的（續費提醒、逾期、停權） */
  listBillingDue(horizonIso: string, limit: number): Promise<TenantBillingRow[]>;
}

/* ------------------------------------------------------------------ OAuth 2.1 */

export interface OAuthClientRow {
  id: string;
  client_id: string;
  kind: "dcr" | "cimd";
  client_name: string | null;
  redirect_uris: string[];
  metadata: Record<string, unknown>;
  created_ip_hash: string | null;
  fetched_at: string | null;
  disabled_at: string | null;
  created_at: string;
}

export interface OAuthGrantRow {
  id: string;
  client_id: string;
  user_id: string;
  tenant_id: string;
  scopes: string[];
  resource: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface OAuthCodeRow {
  id: string;
  code_hash: string;
  grant_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string[];
  resource: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface OAuthTokenRow {
  id: string;
  token_hash: string;
  kind: "access" | "refresh";
  grant_id: string;
  client_id: string;
  scopes: string[];
  resource: string;
  parent_id: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface OAuthStore {
  insertOAuthClient(row: Pick<OAuthClientRow, "client_id" | "kind" | "client_name" | "redirect_uris" | "metadata" | "created_ip_hash" | "fetched_at">): Promise<OAuthClientRow>;
  getOAuthClient(clientId: string): Promise<OAuthClientRow | null>;
  updateOAuthClient(clientId: string, patch: Partial<Pick<OAuthClientRow, "client_name" | "redirect_uris" | "metadata" | "fetched_at" | "disabled_at">>): Promise<void>;
  insertOAuthGrant(row: Pick<OAuthGrantRow, "client_id" | "user_id" | "tenant_id" | "scopes" | "resource">): Promise<OAuthGrantRow>;
  getOAuthGrant(id: string): Promise<OAuthGrantRow | null>;
  listOAuthGrants(opts: { tenantId?: string; userId?: string; limit: number }): Promise<OAuthGrantRow[]>;
  touchOAuthGrant(id: string, nowIso: string): Promise<void>;
  /** 撤銷授權＋底下所有 token（冪等）；回傳是否真的由未撤銷改為撤銷 */
  revokeOAuthGrant(id: string, reason: string): Promise<boolean>;
  insertOAuthCode(row: Pick<OAuthCodeRow, "code_hash" | "grant_id" | "client_id" | "redirect_uri" | "code_challenge" | "scopes" | "resource" | "expires_at">): Promise<void>;
  getOAuthCodeByHash(hash: string): Promise<OAuthCodeRow | null>;
  /** 原子：未使用、未過期才標 used_at 並回傳（一次性） */
  consumeOAuthCode(hash: string, nowIso: string): Promise<OAuthCodeRow | null>;
  insertOAuthToken(row: Pick<OAuthTokenRow, "token_hash" | "kind" | "grant_id" | "client_id" | "scopes" | "resource" | "parent_id" | "expires_at">): Promise<OAuthTokenRow>;
  getOAuthTokenByHash(hash: string): Promise<OAuthTokenRow | null>;
  /** 原子：refresh token 未使用、未撤銷、未過期才標 used_at（輪替；同一個只能換一次） */
  consumeRefreshToken(hash: string, nowIso: string): Promise<OAuthTokenRow | null>;
  revokeOAuthToken(id: string): Promise<void>;
}

export interface PlatformStore extends DomainStore, OwnerStore, PlatformBillingStore, OAuthStore {}
