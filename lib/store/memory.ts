import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type {
  AuditRow,
  DraftRow,
  InquiryRow,
  PortfolioRow,
  PostRow,
  RevisionRow,
  Store,
  TenantModuleRow,
  TenantRow,
  TokenRow,
} from "./types";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 測試用的記憶體實作，語意與 Supabase 實作（含 builder_publish/rollback 函式）一致。 */
export function createMemoryStore(): Store {
  const tenants = new Map<string, TenantRow>();
  const modules = new Map<string, TenantModuleRow>();
  const drafts = new Map<string, DraftRow>();
  const revisions = new Map<string, RevisionRow>();
  const posts = new Map<string, PostRow>();
  const portfolio = new Map<string, PortfolioRow>();
  const inquiries: InquiryRow[] = [];
  const lineClicks: { tenant_id: string }[] = [];
  const tokens = new Map<string, TokenRow>();
  const audit: AuditRow[] = [];
  const rate = new Map<string, number>();

  return {
    async getTenantBySlug(slug) {
      return clone([...tenants.values()].find((t) => t.slug === slug) ?? null);
    },
    async getTenantById(id) {
      return clone(tenants.get(id) ?? null);
    },
    async listTenants() {
      return clone([...tenants.values()]);
    },
    async insertTenant(t) {
      if ([...tenants.values()].some((x) => x.slug === t.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const row: TenantRow = { ...t, id: randomUUID(), published_revision_id: null, created_at: now() };
      tenants.set(row.id, row);
      return clone(row);
    },
    async updateTenant(id, patch) {
      const t = tenants.get(id);
      if (t) tenants.set(id, { ...t, ...patch });
    },

    async listTenantModules(tenantId) {
      return clone([...modules.values()].filter((m) => m.tenant_id === tenantId));
    },
    async upsertTenantModule(row) {
      modules.set(`${row.tenant_id}:${row.module_id}`, clone(row));
    },

    async getDraft(tenantId) {
      return clone(drafts.get(tenantId) ?? null);
    },
    async createDraft(tenantId, content, by) {
      if (drafts.has(tenantId)) throw new ServiceError("conflict", "資料重複：草稿已存在");
      drafts.set(tenantId, { tenant_id: tenantId, content: clone(content), updated_at: now(), updated_by: by, version: 1 });
    },
    async saveDraft(tenantId, content, by, expectedVersion) {
      const d = drafts.get(tenantId);
      if (!d || d.version !== expectedVersion) return null;
      drafts.set(tenantId, { tenant_id: tenantId, content: clone(content), updated_at: now(), updated_by: by, version: expectedVersion + 1 });
      return expectedVersion + 1;
    },
    async publish(tenantId, note, by, expectedDraftVersion) {
      const t = tenants.get(tenantId);
      const d = drafts.get(tenantId);
      if (!t || !d) throw new Error("tenant or draft not found");
      if (expectedDraftVersion !== null && d.version !== expectedDraftVersion) {
        throw new ServiceError("conflict", "草稿在你預覽之後又被修改過了（版本不符）。請重新呼叫 preview_changes 確認最新內容再發布。");
      }
      const number = Math.max(0, ...[...revisions.values()].filter((r) => r.tenant_id === tenantId).map((r) => r.number)) + 1;
      const rev: RevisionRow = { id: randomUUID(), tenant_id: tenantId, number, content: clone(d.content), note, published_by: by, published_at: now() };
      revisions.set(rev.id, rev);
      tenants.set(tenantId, { ...t, published_revision_id: rev.id, theme: clone(d.content.theme) as Record<string, unknown> });
      return { id: rev.id, number, draftVersion: d.version };
    },
    async rollback(tenantId, number, by) {
      const t = tenants.get(tenantId);
      if (!t) throw new Error("tenant not found");
      const rev = [...revisions.values()].find((r) => r.tenant_id === tenantId && r.number === number);
      if (!rev) return null;
      tenants.set(tenantId, { ...t, published_revision_id: rev.id, theme: clone(rev.content.theme) as Record<string, unknown> });
      const prev = drafts.get(tenantId);
      drafts.set(tenantId, { tenant_id: tenantId, content: clone(rev.content), updated_at: now(), updated_by: by, version: (prev?.version ?? 0) + 1 });
      return { id: rev.id, number };
    },
    async listRevisions(tenantId) {
      return [...revisions.values()]
        .filter((r) => r.tenant_id === tenantId)
        .sort((a, b) => b.number - a.number)
        .map(({ content: _c, ...rest }) => clone(rest));
    },
    async getRevision(id) {
      return clone(revisions.get(id) ?? null);
    },

    async listPosts(tenantId, opts) {
      let rows = [...posts.values()].filter((p) => p.tenant_id === tenantId);
      if (opts.status) rows = rows.filter((p) => p.status === opts.status);
      if (opts.publishedBefore) rows = rows.filter((p) => p.published_at && p.published_at <= opts.publishedBefore!);
      rows.sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
      return { rows: clone(rows.slice(opts.offset, opts.offset + opts.limit)), total: rows.length };
    },
    async getPostBySlug(tenantId, slug) {
      return clone([...posts.values()].find((p) => p.tenant_id === tenantId && p.slug === slug) ?? null);
    },
    async getPostById(tenantId, id) {
      const p = posts.get(id);
      return p && p.tenant_id === tenantId ? clone(p) : null;
    },
    async insertPost(row) {
      if ([...posts.values()].some((p) => p.tenant_id === row.tenant_id && p.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const p: PostRow = { ...row, id: randomUUID(), created_at: now(), updated_at: now() };
      posts.set(p.id, p);
      return clone(p);
    },
    async updatePost(tenantId, id, patch) {
      const p = posts.get(id);
      if (!p || p.tenant_id !== tenantId) throw new Error("post not found");
      const next = { ...p, ...patch, updated_at: now() };
      posts.set(id, next);
      return clone(next);
    },

    async listPortfolio(tenantId, opts) {
      return clone(
        [...portfolio.values()]
          .filter((p) => p.tenant_id === tenantId && (!opts.status || p.status === opts.status) && (!opts.tag || p.tags.includes(opts.tag)))
          .sort((a, b) => a.sort - b.sort),
      );
    },
    async getPortfolioItem(tenantId, id) {
      const p = portfolio.get(id);
      return p && p.tenant_id === tenantId ? clone(p) : null;
    },
    async insertPortfolioItem(row) {
      const p: PortfolioRow = { ...row, id: randomUUID(), created_at: now() };
      portfolio.set(p.id, p);
      return clone(p);
    },
    async updatePortfolioItem(tenantId, id, patch) {
      const p = portfolio.get(id);
      if (!p || p.tenant_id !== tenantId) throw new Error("item not found");
      const next = { ...p, ...patch };
      portfolio.set(id, next);
      return clone(next);
    },

    async insertInquiry(row) {
      const r: InquiryRow = { ...row, id: randomUUID(), status: "new", created_at: now() };
      inquiries.push(r);
      return clone(r);
    },
    async listInquiries(tenantId, opts) {
      return clone(
        inquiries
          .filter((i) => i.tenant_id === tenantId && (!opts.status || i.status === opts.status))
          .reverse()
          .slice(0, opts.limit),
      );
    },
    async insertLineClick(row) {
      lineClicks.push({ tenant_id: row.tenant_id });
    },
    async countLineClicks(tenantId) {
      return lineClicks.filter((c) => c.tenant_id === tenantId).length;
    },

    async insertToken(row) {
      const t: TokenRow = { ...row, id: randomUUID(), created_at: now(), last_used_at: null, revoked_at: null };
      tokens.set(t.id, t);
      return clone(t);
    },
    async findTokenByHash(hash) {
      return clone([...tokens.values()].find((t) => t.token_hash === hash) ?? null);
    },
    async touchToken(id) {
      const t = tokens.get(id);
      if (t) t.last_used_at = now();
    },
    async revokeToken(id) {
      const t = tokens.get(id);
      if (!t || t.revoked_at) return null;
      t.revoked_at = now();
      return clone(t);
    },
    async listTokens(tenantId) {
      return clone([...tokens.values()].filter((t) => tenantId === "all" || t.tenant_id === tenantId));
    },
    async getToken(id) {
      return clone(tokens.get(id) ?? null);
    },

    async rateHit(bucket, key, windowSeconds, limit) {
      const w = Math.floor(Date.now() / 1000 / windowSeconds);
      const k = `${bucket}|${key}|${w}`;
      const count = (rate.get(k) ?? 0) + 1; // 單執行緒：讀＋寫在同一個同步區段，等同原子
      rate.set(k, count);
      return { count, allowed: count <= limit };
    },

    async insertAudit(row) {
      audit.push({ ...clone(row), id: audit.length + 1, at: now() });
    },
    async listAudit(tenantId, limit) {
      return clone(audit.filter((a) => !tenantId || a.tenant_id === tenantId).reverse().slice(0, limit));
    },
  };
}
