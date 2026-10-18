import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Store, TenantRow, TokenRow, RevisionSummary } from "./types";
import { ServiceError } from "../errors";
import { createSupabaseCommerceStore } from "./supabase-commerce";

/**
 * Supabase 實作。🔴 一律 service role、只在 server 端使用。
 * fetch 強制 no-store：避免 Next Data Cache 把讀取存起來（發布後前台要立刻看到新版）。
 */
export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
}

function must<T>(r: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (r.error) {
    // unique 衝突轉成友善錯誤，不把約束名回給客戶端
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    if (/draft version mismatch/.test(r.error.message)) {
      throw new ServiceError("conflict", "草稿在你預覽之後又被修改過了（版本不符）。請重新呼叫 preview_changes 確認最新內容再發布。");
    }
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}

const REVISION_COLS = "id, tenant_id, number, note, published_by, published_at";

export function createSupabaseStore(db: SupabaseClient = createServiceClient()): Store {
  return {
    ...createSupabaseCommerceStore(db),
    async getTenantBySlug(slug) {
      return must(await db.from("builder_tenants").select("*").eq("slug", slug).maybeSingle(), "getTenantBySlug");
    },
    async getTenantById(id) {
      return must(await db.from("builder_tenants").select("*").eq("id", id).maybeSingle(), "getTenantById");
    },
    async listTenants() {
      return must(await db.from("builder_tenants").select("*").order("created_at", { ascending: false }).limit(500), "listTenants") ?? [];
    },
    async insertTenant(t) {
      return must(await db.from("builder_tenants").insert(t).select("*").single(), "insertTenant") as TenantRow;
    },
    async updateTenant(id, patch) {
      must(await db.from("builder_tenants").update(patch).eq("id", id), "updateTenant");
    },

    async listTenantModules(tenantId) {
      return must(await db.from("builder_tenant_modules").select("*").eq("tenant_id", tenantId), "listTenantModules") ?? [];
    },
    async upsertTenantModule(row) {
      must(await db.from("builder_tenant_modules").upsert(row, { onConflict: "tenant_id,module_id" }), "upsertTenantModule");
    },

    async getDraft(tenantId) {
      return must(await db.from("builder_site_drafts").select("*").eq("tenant_id", tenantId).maybeSingle(), "getDraft");
    },
    async createDraft(tenantId, content, by) {
      must(await db.from("builder_site_drafts").insert({ tenant_id: tenantId, content, updated_by: by, version: 1 }), "createDraft");
    },
    async saveDraft(tenantId, content, by, expectedVersion) {
      // 條件更新＝樂觀鎖：version 不符時 0 列被更新
      const rows = must(
        await db
          .from("builder_site_drafts")
          .update({ content, updated_by: by, updated_at: new Date().toISOString(), version: expectedVersion + 1 })
          .eq("tenant_id", tenantId)
          .eq("version", expectedVersion)
          .select("version"),
        "saveDraft",
      ) as { version: number }[];
      return rows[0]?.version ?? null;
    },
    async publish(tenantId, note, by, expectedDraftVersion) {
      const rows = must(
        await db.rpc("builder_publish", { p_tenant: tenantId, p_note: note, p_actor: by, p_expected_draft_version: expectedDraftVersion }),
        "publish",
      ) as { revision_id: string; revision_number: number; draft_version: number }[];
      const r = rows[0];
      if (!r) throw new Error("publish: 沒有回傳版本");
      return { id: r.revision_id, number: r.revision_number, draftVersion: r.draft_version };
    },
    async rollback(tenantId, number, by) {
      const rows = must(await db.rpc("builder_rollback", { p_tenant: tenantId, p_number: number, p_actor: by }), "rollback") as {
        revision_id: string;
        revision_number: number;
      }[];
      const r = rows[0];
      return r ? { id: r.revision_id, number: r.revision_number } : null;
    },
    async listRevisions(tenantId) {
      return (must(
        await db.from("builder_site_revisions").select(REVISION_COLS).eq("tenant_id", tenantId).order("number", { ascending: false }).limit(200),
        "listRevisions",
      ) ?? []) as RevisionSummary[];
    },
    async getRevision(id) {
      return must(await db.from("builder_site_revisions").select("*").eq("id", id).maybeSingle(), "getRevision");
    },

    async listPosts(tenantId, opts) {
      let q = db.from("builder_posts").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.publishedBefore) q = q.lte("published_at", opts.publishedBefore);
      const r = await q
        .order("published_at", { ascending: false, nullsFirst: true })
        .order("created_at", { ascending: false })
        .range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listPosts: ${r.error.message}`);
      return { rows: r.data ?? [], total: r.count ?? 0 };
    },
    async getPostBySlug(tenantId, slug) {
      return must(await db.from("builder_posts").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getPostBySlug");
    },
    async getPostById(tenantId, id) {
      return must(await db.from("builder_posts").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getPostById");
    },
    async insertPost(row) {
      return must(await db.from("builder_posts").insert(row).select("*").single(), "insertPost");
    },
    async updatePost(tenantId, id, patch) {
      return must(
        await db
          .from("builder_posts")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .select("*")
          .single(),
        "updatePost",
      );
    },

    async listPortfolio(tenantId, opts) {
      let q = db.from("builder_portfolio_items").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.tag) q = q.contains("tags", [opts.tag]);
      return must(await q.order("sort").order("created_at", { ascending: false }).limit(200), "listPortfolio") ?? [];
    },
    async getPortfolioItem(tenantId, id) {
      return must(await db.from("builder_portfolio_items").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getPortfolioItem");
    },
    async insertPortfolioItem(row) {
      return must(await db.from("builder_portfolio_items").insert(row).select("*").single(), "insertPortfolioItem");
    },
    async updatePortfolioItem(tenantId, id, patch) {
      return must(
        await db.from("builder_portfolio_items").update(patch).eq("tenant_id", tenantId).eq("id", id).select("*").single(),
        "updatePortfolioItem",
      );
    },

    async insertInquiry(row) {
      return must(await db.from("builder_inquiries").insert(row).select("*").single(), "insertInquiry");
    },
    async listInquiries(tenantId, opts) {
      let q = db.from("builder_inquiries").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return must(await q.order("created_at", { ascending: false }).limit(opts.limit), "listInquiries") ?? [];
    },
    async insertLineClick(row) {
      must(await db.from("builder_line_clicks").insert(row), "insertLineClick");
    },
    async countLineClicks(tenantId) {
      const r = await db.from("builder_line_clicks").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
      if (r.error) throw new Error(`countLineClicks: ${r.error.message}`);
      return r.count ?? 0;
    },

    async insertToken(row) {
      return must(await db.from("builder_api_tokens").insert(row).select("*").single(), "insertToken") as TokenRow;
    },
    async findTokenByHash(hash) {
      return must(await db.from("builder_api_tokens").select("*").eq("token_hash", hash).maybeSingle(), "findTokenByHash");
    },
    async touchToken(id) {
      must(await db.from("builder_api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", id), "touchToken");
    },
    async revokeToken(id) {
      return must(
        await db.from("builder_api_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null).select("*").maybeSingle(),
        "revokeToken",
      );
    },
    async listTokens(tenantId) {
      let q = db.from("builder_api_tokens").select("*");
      if (tenantId === null) q = q.is("tenant_id", null);
      else if (tenantId !== "all") q = q.eq("tenant_id", tenantId);
      return must(await q.order("created_at", { ascending: false }).limit(500), "listTokens") ?? [];
    },
    async getToken(id) {
      return must(await db.from("builder_api_tokens").select("*").eq("id", id).maybeSingle(), "getToken");
    },

    async rateHit(bucket, key, windowSeconds, limit) {
      const rows = must(
        await db.rpc("builder_rate_hit", { p_bucket: bucket, p_key: key, p_window_seconds: windowSeconds, p_limit: limit }),
        "rateHit",
      ) as { hit_count: number; allowed: boolean }[];
      const r = rows[0];
      if (!r) throw new Error("rateHit: 沒有回傳");
      return { count: r.hit_count, allowed: r.allowed };
    },

    async insertAudit(row) {
      must(await db.from("builder_audit_log").insert(row), "insertAudit");
    },
    async listAudit(tenantId, limit) {
      let q = db.from("builder_audit_log").select("*");
      if (tenantId) q = q.eq("tenant_id", tenantId);
      return must(await q.order("at", { ascending: false }).limit(limit), "listAudit") ?? [];
    },
  };
}
