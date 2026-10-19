import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { OAuthClientRow, OAuthCodeRow, OAuthGrantRow, OAuthTokenRow, OwnerSessionRow, OwnerTokenRow, OwnerUserRow, PlatformOrderRow, PlatformStore, TenantBillingRow, TenantDomainRow, TenantUserRow } from "./types-platform";

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
  const orderById = async (id: string) => {
    if (!isUuid(id)) return null;
    return must(await db.from("builder_platform_orders").select("*").eq("id", id).maybeSingle(), "getPlatformOrderById") as PlatformOrderRow | null;
  };
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
      if (!isUuid(tenantId) || !isUuid(userId)) return null;
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
    async insertPlatformOrder(row) {
      return must(await db.from("builder_platform_orders").insert(row).select("*").single(), "insertPlatformOrder") as PlatformOrderRow;
    },
    getPlatformOrderById: orderById,
    async getPlatformOrderByNo(no) {
      if (!/^GP-\d{8}-[A-Z0-9]{6}$/.test(no)) return null;
      return must(await db.from("builder_platform_orders").select("*").eq("order_no", no).maybeSingle(), "getPlatformOrderByNo") as PlatformOrderRow | null;
    },
    async getPlatformOrderByGatewayNo(no) {
      if (!/^[A-Za-z0-9]{1,20}$/.test(no)) return null;
      return must(await db.from("builder_platform_orders").select("*").eq("gateway_order_no", no).maybeSingle(), "getPlatformOrderByGatewayNo") as PlatformOrderRow | null;
    },
    async updatePlatformOrder(id, patch, where) {
      if (!isUuid(id)) return null;
      let q = db.from("builder_platform_orders").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (where?.status) q = q.in("status", where.status);
      if (where?.provision_state) q = q.in("provision_state", where.provision_state);
      if (where?.gatewayIsNull) q = q.is("gateway_order_no", null);
      if (where?.alertedIsNull) q = q.is("alerted_at", null);
      const rows = (must(await q.select("*"), "updatePlatformOrder") ?? []) as PlatformOrderRow[];
      return rows[0] ?? null;
    },
    async claimPlatformProvision(id, staleBeforeIso) {
      const cur = await orderById(id);
      if (!cur || cur.status !== "paid") return null;
      // 樂觀鎖：attempts 必須還是讀到的值＋狀態條件，同時只有一個宣告成功
      const rows = (must(
        await db
          .from("builder_platform_orders")
          .update({ provision_state: "provisioning", provision_claimed_at: new Date().toISOString(), provision_attempts: cur.provision_attempts + 1, updated_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "paid")
          .eq("provision_attempts", cur.provision_attempts)
          .or(`provision_state.in.(none,failed),and(provision_state.eq.provisioning,provision_claimed_at.lt.${staleBeforeIso})`)
          .select("*"),
        "claimPlatformProvision",
      ) ?? []) as PlatformOrderRow[];
      return rows[0] ?? null;
    },
    async listPlatformOrders(opts) {
      let q = db.from("builder_platform_orders").select("*");
      if (opts.tenantId) q = q.eq("tenant_id", opts.tenantId);
      if (opts.status) q = q.in("status", opts.status);
      if (opts.kind) q = q.eq("kind", opts.kind);
      return (must(await q.order("created_at", { ascending: false }).limit(opts.limit), "listPlatformOrders") ?? []) as PlatformOrderRow[];
    },
    async listPlatformOrdersForSweep(nowIso, staleBeforeIso, limit) {
      const a = (must(await db.from("builder_platform_orders").select("*").eq("status", "pending_payment").lte("expires_at", nowIso).limit(limit), "sweepPending") ?? []) as PlatformOrderRow[];
      const b = (must(
        await db.from("builder_platform_orders").select("*").eq("status", "paid").lt("provision_attempts", 10).or(`provision_state.in.(none,failed),and(provision_state.eq.provisioning,provision_claimed_at.lt.${staleBeforeIso})`).limit(limit),
        "sweepProvision",
      ) ?? []) as PlatformOrderRow[];
      return [...a, ...b];
    },
    async getTenantBilling(tenantId) {
      return must(await db.from("builder_tenant_billing").select("*").eq("tenant_id", tenantId).maybeSingle(), "getTenantBilling") as TenantBillingRow | null;
    },
    async insertTenantBilling(row) {
      const r = await db.from("builder_tenant_billing").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertTenantBilling") as TenantBillingRow;
    },
    async updateTenantBilling(tenantId, patch, whereStatus) {
      let q = db.from("builder_tenant_billing").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId);
      if (whereStatus) q = q.in("status", whereStatus);
      const rows = (must(await q.select("*"), "updateTenantBilling") ?? []) as TenantBillingRow[];
      return rows[0] ?? null;
    },
    async listBillingDue(horizonIso, limit) {
      return (must(await db.from("builder_tenant_billing").select("*").neq("status", "suspended").lte("paid_until", horizonIso).order("paid_until").limit(limit), "listBillingDue") ?? []) as TenantBillingRow[];
    },
    async insertOAuthClient(row) {
      return must(await db.from("builder_oauth_clients").insert(row).select("*").single(), "insertOAuthClient") as OAuthClientRow;
    },
    async getOAuthClient(clientId) {
      if (!clientId || clientId.length > 500) return null;
      return must(await db.from("builder_oauth_clients").select("*").eq("client_id", clientId).maybeSingle(), "getOAuthClient") as OAuthClientRow | null;
    },
    async updateOAuthClient(clientId, patch) {
      must(await db.from("builder_oauth_clients").update(patch).eq("client_id", clientId), "updateOAuthClient");
    },
    async insertOAuthGrant(row) {
      return must(await db.from("builder_oauth_grants").insert(row).select("*").single(), "insertOAuthGrant") as OAuthGrantRow;
    },
    async getOAuthGrant(id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_oauth_grants").select("*").eq("id", id).maybeSingle(), "getOAuthGrant") as OAuthGrantRow | null;
    },
    async listOAuthGrants(opts) {
      let q = db.from("builder_oauth_grants").select("*");
      if (opts.tenantId) q = q.eq("tenant_id", opts.tenantId);
      if (opts.userId) q = q.eq("user_id", opts.userId);
      return (must(await q.order("created_at", { ascending: false }).limit(opts.limit), "listOAuthGrants") ?? []) as OAuthGrantRow[];
    },
    async touchOAuthGrant(id, nowIso) {
      must(await db.from("builder_oauth_grants").update({ last_used_at: nowIso }).eq("id", id), "touchOAuthGrant");
    },
    async revokeOAuthGrant(id, reason) {
      if (!isUuid(id)) return false;
      const nowIso = new Date().toISOString();
      must(await db.from("builder_oauth_tokens").update({ revoked_at: nowIso }).eq("grant_id", id).is("revoked_at", null), "revokeGrantTokens");
      const rows = (must(await db.from("builder_oauth_grants").update({ revoked_at: nowIso, revoked_reason: reason }).eq("id", id).is("revoked_at", null).select("id"), "revokeOAuthGrant") ?? []) as { id: string }[];
      return rows.length === 1;
    },
    async insertOAuthCode(row) {
      must(await db.from("builder_oauth_codes").insert(row), "insertOAuthCode");
    },
    async getOAuthCodeByHash(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      return must(await db.from("builder_oauth_codes").select("*").eq("code_hash", hash).maybeSingle(), "getOAuthCodeByHash") as OAuthCodeRow | null;
    },
    async consumeOAuthCode(hash, nowIso) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const rows = (must(await db.from("builder_oauth_codes").update({ used_at: nowIso }).eq("code_hash", hash).is("used_at", null).gt("expires_at", nowIso).select("*"), "consumeOAuthCode") ?? []) as OAuthCodeRow[];
      return rows[0] ?? null;
    },
    async insertOAuthToken(row) {
      return must(await db.from("builder_oauth_tokens").insert(row).select("*").single(), "insertOAuthToken") as OAuthTokenRow;
    },
    async getOAuthTokenByHash(hash) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      return must(await db.from("builder_oauth_tokens").select("*").eq("token_hash", hash).maybeSingle(), "getOAuthTokenByHash") as OAuthTokenRow | null;
    },
    async consumeRefreshToken(hash, nowIso) {
      if (!/^[0-9a-f]{64}$/.test(hash)) return null;
      const rows = (must(await db.from("builder_oauth_tokens").update({ used_at: nowIso }).eq("token_hash", hash).eq("kind", "refresh").is("used_at", null).is("revoked_at", null).gt("expires_at", nowIso).select("*"), "consumeRefreshToken") ?? []) as OAuthTokenRow[];
      return rows[0] ?? null;
    },
    async revokeOAuthToken(id) {
      must(await db.from("builder_oauth_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", id).is("revoked_at", null), "revokeOAuthToken");
    },
    async listPendingDomains(limit) {
      return (must(await db.from("builder_tenant_domains").select("*").eq("status", "pending").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(limit), "listPendingDomains") ?? []) as TenantDomainRow[];
    },
  };
}
