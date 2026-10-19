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

export interface PlatformStore extends DomainStore, OwnerStore {}
