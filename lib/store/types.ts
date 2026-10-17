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
  saveDraft(tenantId: string, content: SiteContent, by: string): Promise<void>;
  /** 原子操作：草稿凍結為下一版並設為已發布 */
  publish(tenantId: string, note: string | null, by: string): Promise<{ id: string; number: number }>;
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
  countInquiriesSince(tenantId: string, ipHash: string, sinceIso: string): Promise<number>;
  insertLineClick(row: { tenant_id: string; path: string | null; placement: string | null; ip_hash: string | null; user_agent: string | null }): Promise<void>;
  countLineClicks(tenantId: string): Promise<number>;

  // tokens
  insertToken(row: Omit<TokenRow, "id" | "created_at" | "last_used_at" | "revoked_at">): Promise<TokenRow>;
  findTokenByHash(hash: string): Promise<TokenRow | null>;
  touchToken(id: string): Promise<void>;
  revokeToken(id: string): Promise<TokenRow | null>;
  listTokens(tenantId: string | null | "all"): Promise<TokenRow[]>;
  getToken(id: string): Promise<TokenRow | null>;

  // audit
  insertAudit(row: Omit<AuditRow, "id" | "at">): Promise<void>;
  listAudit(tenantId: string | null, limit: number): Promise<AuditRow[]>;
}
