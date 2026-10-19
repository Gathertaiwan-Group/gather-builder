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

export interface PlatformStore extends DomainStore {}
