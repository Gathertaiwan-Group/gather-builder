import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { Store } from "./types";
import type { OAuthClientRow, OAuthCodeRow, OAuthGrantRow, OAuthTokenRow, OwnerSessionRow, OwnerTokenRow, OwnerUserRow, PlatformOrderRow, PlatformStore, TenantBillingRow, TenantDomainRow, TenantUserRow } from "./types-platform";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 第九批的記憶體實作（語意與 migrations 0038+ 的 SQL 一致）。attach(store) 後才能改租戶的 primary_domain。 */
export function createMemoryPlatformStore() {
  const domains = new Map<string, TenantDomainRow>();
  const users = new Map<string, OwnerUserRow>();
  const members = new Map<string, TenantUserRow>();
  const sessions = new Map<string, OwnerSessionRow>();
  const tokens = new Map<string, OwnerTokenRow>();
  const porders = new Map<string, PlatformOrderRow>();
  const billing = new Map<string, TenantBillingRow>();
  const oclients = new Map<string, OAuthClientRow>();
  const ogrants = new Map<string, OAuthGrantRow>();
  const ocodes = new Map<string, OAuthCodeRow>();
  const otokens = new Map<string, OAuthTokenRow>();
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
    async insertPlatformOrder(row) {
      const live = (o: PlatformOrderRow) => o.status === "pending_payment" || o.status === "paid";
      for (const o of porders.values()) {
        if (o.order_no === row.order_no) throw new ServiceError("conflict", "資料重複");
        if (row.kind === "new_site" && o.kind === "new_site" && row.slug && o.slug === row.slug && live(o)) throw new ServiceError("conflict", "資料重複");
        if (row.kind === "renewal" && o.kind === "renewal" && o.tenant_id === row.tenant_id && o.period_start === row.period_start && live(o)) throw new ServiceError("conflict", "資料重複");
      }
      const r: PlatformOrderRow = { ...clone(row), id: randomUUID(), status: "pending_payment", gateway_order_no: null, payment_url: null, paid_at: null, paid_amount: null, query_failures: 0, provision_state: "none", provision_claimed_at: null, provision_attempts: 0, provision_error: null, provisioned_at: null, alerted_at: null, created_at: now(), updated_at: now() };
      porders.set(r.id, r);
      return clone(r);
    },
    async getPlatformOrderById(id) {
      return clone(porders.get(id) ?? null);
    },
    async getPlatformOrderByNo(no) {
      return clone([...porders.values()].find((o) => o.order_no === no) ?? null);
    },
    async getPlatformOrderByGatewayNo(no) {
      return clone([...porders.values()].find((o) => o.gateway_order_no === no) ?? null);
    },
    async updatePlatformOrder(id, patch, where) {
      const o = porders.get(id);
      if (!o) return null;
      if (where?.status && !where.status.includes(o.status)) return null;
      if (where?.provision_state && !where.provision_state.includes(o.provision_state)) return null;
      if (where?.gatewayIsNull && o.gateway_order_no) return null;
      if (where?.alertedIsNull && o.alerted_at) return null;
      if (patch.gateway_order_no && [...porders.values()].some((x) => x.id !== id && x.gateway_order_no === patch.gateway_order_no)) throw new ServiceError("conflict", "資料重複");
      const next = { ...o, ...clone(patch), updated_at: now() };
      porders.set(id, next);
      return clone(next);
    },
    async claimPlatformProvision(id, staleBeforeIso) {
      const o = porders.get(id);
      if (!o || o.status !== "paid") return null;
      const ok = o.provision_state === "none" || o.provision_state === "failed" || (o.provision_state === "provisioning" && (o.provision_claimed_at ?? "") < staleBeforeIso);
      if (!ok) return null;
      const next: PlatformOrderRow = { ...o, provision_state: "provisioning", provision_claimed_at: now(), provision_attempts: o.provision_attempts + 1, updated_at: now() };
      porders.set(id, next);
      return clone(next);
    },
    async listPlatformOrders(opts) {
      return clone([...porders.values()].filter((o) => (!opts.tenantId || o.tenant_id === opts.tenantId) && (!opts.status || opts.status.includes(o.status)) && (!opts.kind || o.kind === opts.kind)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, opts.limit));
    },
    async listPlatformOrdersForSweep(nowIso, staleBeforeIso, limit) {
      return clone([...porders.values()].filter((o) => (o.status === "pending_payment" && o.expires_at <= nowIso) || (o.status === "paid" && o.provision_attempts < 10 && (o.provision_state === "none" || o.provision_state === "failed" || (o.provision_state === "provisioning" && (o.provision_claimed_at ?? "") < staleBeforeIso)))).slice(0, limit));
    },
    async getTenantBilling(tenantId) {
      return clone(billing.get(tenantId) ?? null);
    },
    async insertTenantBilling(row) {
      if (billing.has(row.tenant_id)) return null;
      const r: TenantBillingRow = { ...clone(row), status: "active", grace_until: null, cancel_at_period_end: false, suspended_at: null, created_at: now(), updated_at: now() };
      billing.set(row.tenant_id, r);
      return clone(r);
    },
    async updateTenantBilling(tenantId, patch, whereStatus) {
      const b = billing.get(tenantId);
      if (!b || (whereStatus && !whereStatus.includes(b.status))) return null;
      const next = { ...b, ...clone(patch), updated_at: now() };
      billing.set(tenantId, next);
      return clone(next);
    },
    async listBillingDue(horizonIso, limit) {
      return clone([...billing.values()].filter((b) => b.status !== "suspended" && b.paid_until <= horizonIso).slice(0, limit));
    },
    async insertOAuthClient(row) {
      if (oclients.has(row.client_id)) throw new ServiceError("conflict", "資料重複");
      const r: OAuthClientRow = { ...clone(row), id: randomUUID(), disabled_at: null, created_at: now() };
      oclients.set(r.client_id, r);
      return clone(r);
    },
    async getOAuthClient(clientId) {
      return clone(oclients.get(clientId) ?? null);
    },
    async updateOAuthClient(clientId, patch) {
      const c = oclients.get(clientId);
      if (c) oclients.set(clientId, { ...c, ...clone(patch) });
    },
    async insertOAuthGrant(row) {
      const r: OAuthGrantRow = { ...clone(row), id: randomUUID(), created_at: now(), last_used_at: null, revoked_at: null, revoked_reason: null };
      ogrants.set(r.id, r);
      return clone(r);
    },
    async getOAuthGrant(id) {
      return clone(ogrants.get(id) ?? null);
    },
    async listOAuthGrants(opts) {
      return clone([...ogrants.values()].filter((g) => (!opts.tenantId || g.tenant_id === opts.tenantId) && (!opts.userId || g.user_id === opts.userId)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, opts.limit));
    },
    async touchOAuthGrant(id, nowIso) {
      const g = ogrants.get(id);
      if (g) ogrants.set(id, { ...g, last_used_at: nowIso });
    },
    async revokeOAuthGrant(id, reason) {
      const g = ogrants.get(id);
      if (!g) return false;
      for (const t of otokens.values()) if (t.grant_id === id && !t.revoked_at) otokens.set(t.id, { ...t, revoked_at: now() });
      if (g.revoked_at) return false;
      ogrants.set(id, { ...g, revoked_at: now(), revoked_reason: reason });
      return true;
    },
    async insertOAuthCode(row) {
      const r: OAuthCodeRow = { ...clone(row), id: randomUUID(), used_at: null, created_at: now() };
      ocodes.set(r.code_hash, r);
    },
    async getOAuthCodeByHash(hash) {
      return clone(ocodes.get(hash) ?? null);
    },
    async consumeOAuthCode(hash, nowIso) {
      const c = ocodes.get(hash);
      if (!c || c.used_at || c.expires_at <= nowIso) return null;
      const next = { ...c, used_at: nowIso };
      ocodes.set(hash, next);
      return clone(next);
    },
    async insertOAuthToken(row) {
      const r: OAuthTokenRow = { ...clone(row), id: randomUUID(), used_at: null, revoked_at: null, created_at: now() };
      otokens.set(r.id, r);
      return clone(r);
    },
    async getOAuthTokenByHash(hash) {
      return clone([...otokens.values()].find((t) => t.token_hash === hash) ?? null);
    },
    async consumeRefreshToken(hash, nowIso) {
      const t = [...otokens.values()].find((x) => x.token_hash === hash);
      if (!t || t.kind !== "refresh" || t.used_at || t.revoked_at || t.expires_at <= nowIso) return null;
      const next = { ...t, used_at: nowIso };
      otokens.set(t.id, next);
      return clone(next);
    },
    async revokeOAuthToken(id) {
      const t = otokens.get(id);
      if (t && !t.revoked_at) otokens.set(id, { ...t, revoked_at: now() });
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
