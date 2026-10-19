import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { Store } from "./types";
import type { OwnerSessionRow, OwnerTokenRow, OwnerUserRow, PlatformStore, TenantDomainRow, TenantUserRow } from "./types-platform";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 第九批的記憶體實作（語意與 migrations 0038+ 的 SQL 一致）。attach(store) 後才能改租戶的 primary_domain。 */
export function createMemoryPlatformStore() {
  const domains = new Map<string, TenantDomainRow>();
  const users = new Map<string, OwnerUserRow>();
  const members = new Map<string, TenantUserRow>();
  const sessions = new Map<string, OwnerSessionRow>();
  const tokens = new Map<string, OwnerTokenRow>();
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

    async insertOwnerUser(row) {
      if ([...users.values()].some((u) => u.email === row.email)) throw new ServiceError("conflict", "資料重複");
      const u: OwnerUserRow = { ...clone(row), id: randomUUID(), status: "active", totp_secret_enc: null, totp_enabled_at: null, totp_last_step: null, last_login_at: null, created_at: now(), updated_at: now() };
      users.set(u.id, u);
      return clone(u);
    },
    async getOwnerUserByEmail(email) {
      return clone([...users.values()].find((u) => u.email === email) ?? null);
    },
    async getOwnerUserById(id) {
      return clone(users.get(id) ?? null);
    },
    async updateOwnerUser(id, patch) {
      const u = users.get(id);
      if (!u) return null;
      const next = { ...u, ...clone(patch), updated_at: now() };
      users.set(id, next);
      return clone(next);
    },
    async claimTotpStep(userId, step) {
      const u = users.get(userId);
      if (!u || (u.totp_last_step !== null && u.totp_last_step >= step)) return false;
      users.set(userId, { ...u, totp_last_step: step });
      return true;
    },
    async insertTenantUser(row) {
      if ([...members.values()].some((m) => m.tenant_id === row.tenant_id && m.user_id === row.user_id)) throw new ServiceError("conflict", "資料重複");
      const m: TenantUserRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      members.set(m.id, m);
      return clone(m);
    },
    async getTenantUser(tenantId, userId) {
      return clone([...members.values()].find((m) => m.tenant_id === tenantId && m.user_id === userId) ?? null);
    },
    async getTenantUserById(tenantId, id) {
      const m = members.get(id);
      return m && m.tenant_id === tenantId ? clone(m) : null;
    },
    async listTenantUsers(tenantId) {
      return clone([...members.values()].filter((m) => m.tenant_id === tenantId));
    },
    async listUserMemberships(userId) {
      return clone([...members.values()].filter((m) => m.user_id === userId));
    },
    async updateTenantUser(tenantId, id, patch) {
      const m = members.get(id);
      if (!m || m.tenant_id !== tenantId) return null;
      const next = { ...m, ...clone(patch), updated_at: now() };
      members.set(id, next);
      return clone(next);
    },
    async insertOwnerSession(row) {
      const r: OwnerSessionRow = { ...clone(row), id: randomUUID(), created_at: now(), last_seen_at: now(), revoked_at: null };
      sessions.set(r.id, r);
      return clone(r);
    },
    async getOwnerSessionByHash(hash) {
      return clone([...sessions.values()].find((x) => x.token_hash === hash) ?? null);
    },
    async touchOwnerSession(id, nowIso) {
      const x = sessions.get(id);
      if (x) sessions.set(id, { ...x, last_seen_at: nowIso });
    },
    async revokeOwnerSession(id) {
      const x = sessions.get(id);
      if (x && !x.revoked_at) sessions.set(id, { ...x, revoked_at: now() });
    },
    async revokeOwnerSessionsForUser(userId) {
      let n = 0;
      for (const x of sessions.values()) if (x.user_id === userId && !x.revoked_at) {
        sessions.set(x.id, { ...x, revoked_at: now() });
        n++;
      }
      return n;
    },
    async insertOwnerToken(row) {
      const r: OwnerTokenRow = { ...clone(row), id: randomUUID(), used_at: null, created_at: now() };
      tokens.set(r.id, r);
    },
    async peekOwnerToken(hash, purpose, nowIso) {
      const t = [...tokens.values()].find((x) => x.token_hash === hash);
      return t && t.purpose === purpose && !t.used_at && t.expires_at > nowIso ? clone(t) : null;
    },
    async consumeOwnerToken(hash, purpose, nowIso) {
      const t = [...tokens.values()].find((x) => x.token_hash === hash);
      if (!t || t.purpose !== purpose || t.used_at || t.expires_at <= nowIso) return null;
      const next = { ...t, used_at: nowIso };
      tokens.set(t.id, next);
      return clone(next);
    },
    async invalidateOwnerTokens(userId, purpose) {
      for (const t of tokens.values()) if (t.user_id === userId && t.purpose === purpose && !t.used_at) tokens.set(t.id, { ...t, used_at: now() });
    },
  };
  return {
    store,
    attach(s: Store) {
      root = s;
    },
  };
}
