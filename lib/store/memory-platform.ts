import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { Store } from "./types";
import type { PlatformStore, TenantDomainRow } from "./types-platform";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 第九批的記憶體實作（語意與 migrations 0038+ 的 SQL 一致）。attach(store) 後才能改租戶的 primary_domain。 */
export function createMemoryPlatformStore() {
  const domains = new Map<string, TenantDomainRow>();
  let root: Store | null = null;
  const store: PlatformStore = {
    async insertTenantDomain(row) {
      if ([...domains.values()].some((d) => d.domain === row.domain)) throw new ServiceError("conflict", "資料重複：這個網域已被使用");
      const r: TenantDomainRow = { ...clone(row), id: randomUUID(), status: "pending", verify_method: "vercel", last_checked_at: null, last_error: null, verified_at: null, activated_at: null, created_at: now(), updated_at: now() };
      domains.set(r.id, r);
      return clone(r);
    },
    async listTenantDomains(tenantId) {
      return clone([...domains.values()].filter((d) => d.tenant_id === tenantId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    },
    async getTenantDomain(tenantId, id) {
      const d = domains.get(id);
      return d && d.tenant_id === tenantId ? clone(d) : null;
    },
    async getDomainByName(domain) {
      return clone([...domains.values()].find((d) => d.domain === domain) ?? null);
    },
    async updateTenantDomain(tenantId, id, patch, from) {
      const d = domains.get(id);
      if (!d || d.tenant_id !== tenantId || (from && !from.includes(d.status))) return null;
      const next = { ...d, ...clone(patch), updated_at: now() };
      domains.set(id, next);
      return clone(next);
    },
    async activateTenantDomain(tenantId, id) {
      const d = domains.get(id);
      if (!d || d.tenant_id !== tenantId || (d.status !== "verified" && d.status !== "active")) throw new ServiceError("invalid", "網域尚未驗證完成");
      for (const x of domains.values()) if (x.tenant_id === tenantId && x.status === "active" && x.id !== id) domains.set(x.id, { ...x, status: "verified", updated_at: now() });
      domains.set(id, { ...d, status: "active", activated_at: d.activated_at ?? now(), updated_at: now() });
      await root!.updateTenant(tenantId, { primary_domain: d.domain });
      return d.domain;
    },
    async deleteTenantDomain(tenantId, id) {
      const d = domains.get(id);
      if (!d || d.tenant_id !== tenantId) return false;
      domains.delete(id);
      const t = await root!.getTenantById(tenantId);
      if (t?.primary_domain === d.domain) await root!.updateTenant(tenantId, { primary_domain: null });
      return true;
    },
    async listPendingDomains(limit) {
      return clone([...domains.values()].filter((d) => d.status === "pending").slice(0, limit));
    },
  };
  return {
    store,
    attach(s: Store) {
      root = s;
    },
  };
}
