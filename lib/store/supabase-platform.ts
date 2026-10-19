import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { OwnerSessionRow, OwnerTokenRow, OwnerUserRow, PlatformStore, TenantDomainRow, TenantUserRow } from "./types-platform";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function createSupabasePlatformStore(db: SupabaseClient): PlatformStore {
  return {
    async insertTenantDomain(row) {
      const r = await db.from("builder_tenant_domains").insert(row).select("*").single();
      if (r.error?.code === "23505") throw new ServiceError("conflict", "資料重複：這個網域已被使用");
      return must(r, "insertTenantDomain") as TenantDomainRow;
    },
    async listTenantDomains(tenantId) {
      return (must(await db.from("builder_tenant_domains").select("*").eq("tenant_id", tenantId).order("created_at"), "listTenantDomains") ?? []) as TenantDomainRow[];
    },
    async getTenantDomain(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_tenant_domains").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getTenantDomain") as TenantDomainRow | null;
    },
    async getDomainByName(domain) {
      return must(await db.from("builder_tenant_domains").select("*").eq("domain", domain).maybeSingle(), "getDomainByName") as TenantDomainRow | null;
    },
    async updateTenantDomain(tenantId, id, patch, from) {
      if (!isUuid(id)) return null;
      let q = db.from("builder_tenant_domains").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id);
      if (from) q = q.in("status", from);
      const rows = (must(await q.select("*"), "updateTenantDomain") ?? []) as TenantDomainRow[];
      return rows[0] ?? null;
    },
    async activateTenantDomain(tenantId, id) {
      const r = await db.rpc("builder_activate_domain", { p_tenant: tenantId, p_domain_id: id });
      if (r.error && /domain not verified/.test(r.error.message)) throw new ServiceError("invalid", "網域尚未驗證完成");
      return must(r, "activateTenantDomain") as string;
    },
    async deleteTenantDomain(tenantId, id) {
      if (!isUuid(id)) return false;
      const rows = (must(await db.from("builder_tenant_domains").delete().eq("tenant_id", tenantId).eq("id", id).select("domain"), "deleteTenantDomain") ?? []) as { domain: string }[];
      if (!rows[0]) return false;
      must(await db.from("builder_tenants").update({ primary_domain: null }).eq("id", tenantId).eq("primary_domain", rows[0].domain), "clearPrimaryDomain");
      return true;
    },
    async insertOwnerUser(row) {
      return must(await db.from("builder_owner_users").insert(row).select("*").single(), "insertOwnerUser") as OwnerUserRow;
    },
    async getOwnerUserByEmail(email) {
      return must(await db.from("builder_owner_users").select("*").eq("email", email).maybeSingle(), "getOwnerUserByEmail") as OwnerUserRow | null;
    },
    async getOwnerUserById(id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_owner_users").select("*").eq("id", id).maybeSingle(), "getOwnerUserById") as OwnerUserRow | null;
    },
    async updateOwnerUser(id, patch) {
      const rows = (must(await db.from("builder_owner_users").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*"), "updateOwnerUser") ?? []) as OwnerUserRow[];
      return rows[0] ?? null;
    },
    async claimTotpStep(userId, step) {
      const rows = (must(await db.from("builder_owner_users").update({ totp_last_step: step }).eq("id", userId).or(`totp_last_step.is.null,totp_last_step.lt.${Math.floor(step)}`).select("id"), "claimTotpStep") ?? []) as { id: string }[];
      return rows.length === 1;
    },
    async insertTenantUser(row) {
      return must(await db.from("builder_tenant_users").insert(row).select("*").single(), "insertTenantUser") as TenantUserRow;
    },
    async getTenantUser(tenantId, userId) {
      return must(await db.from("builder_tenant_users").select("*").eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle(), "getTenantUser") as TenantUserRow | null;
    },
    async getTenantUserById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_tenant_users").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getTenantUserById") as TenantUserRow | null;
    },
    async listTenantUsers(tenantId) {
      return (must(await db.from("builder_tenant_users").select("*").eq("tenant_id", tenantId).order("created_at"), "listTenantUsers") ?? []) as TenantUserRow[];
    },
    async listUserMemberships(userId) {
      return (must(await db.from("builder_tenant_users").select("*").eq("user_id", userId).order("created_at"), "listUserMemberships") ?? []) as TenantUserRow[];
    },
    async updateTenantUser(tenantId, id, patch) {
      const rows = (must(await db.from("builder_tenant_users").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).select("*"), "updateTenantUser") ?? []) as TenantUserRow[];
      return rows[0] ?? null;
    },
    async insertOwnerSession(row) {
      return must(await db.from("builder_owner_sessions").insert(row).select("*").single(), "insertOwnerSession") as OwnerSessionRow;
    },
    async getOwnerSessionByHash(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      return must(await db.from("builder_owner_sessions").select("*").eq("token_hash", hash).maybeSingle(), "getOwnerSessionByHash") as OwnerSessionRow | null;
    },
    async touchOwnerSession(id, nowIso) {
      must(await db.from("builder_owner_sessions").update({ last_seen_at: nowIso }).eq("id", id), "touchOwnerSession");
    },
    async revokeOwnerSession(id) {
      must(await db.from("builder_owner_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null), "revokeOwnerSession");
    },
    async revokeOwnerSessionsForUser(userId) {
      const rows = (must(await db.from("builder_owner_sessions").update({ revoked_at: new Date().toISOString() }).eq("user_id", userId).is("revoked_at", null).select("id"), "revokeOwnerSessionsForUser") ?? []) as { id: string }[];
      return rows.length;
    },
    async insertOwnerToken(row) {
      must(await db.from("builder_owner_tokens").insert(row), "insertOwnerToken");
    },
    async peekOwnerToken(hash, purpose, nowIso) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      return must(await db.from("builder_owner_tokens").select("*").eq("token_hash", hash).eq("purpose", purpose).is("used_at", null).gt("expires_at", nowIso).maybeSingle(), "peekOwnerToken") as OwnerTokenRow | null;
    },
    async consumeOwnerToken(hash, purpose, nowIso) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const rows = (must(await db.from("builder_owner_tokens").update({ used_at: nowIso }).eq("token_hash", hash).eq("purpose", purpose).is("used_at", null).gt("expires_at", nowIso).select("*"), "consumeOwnerToken") ?? []) as OwnerTokenRow[];
      return rows[0] ?? null;
    },
    async invalidateOwnerTokens(userId, purpose) {
      must(await db.from("builder_owner_tokens").update({ used_at: new Date().toISOString() }).eq("user_id", userId).eq("purpose", purpose).is("used_at", null), "invalidateOwnerTokens");
    },
    async listPendingDomains(limit) {
      return (must(await db.from("builder_tenant_domains").select("*").eq("status", "pending").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(limit), "listPendingDomains") ?? []) as TenantDomainRow[];
    },
  };
}
