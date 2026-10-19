import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { PlatformStore, TenantDomainRow } from "./types-platform";

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
    async listPendingDomains(limit) {
      return (must(await db.from("builder_tenant_domains").select("*").eq("status", "pending").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(limit), "listPendingDomains") ?? []) as TenantDomainRow[];
    },
  };
}
