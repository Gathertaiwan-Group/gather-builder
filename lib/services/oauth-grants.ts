import { ServiceError, audit, resolveTenant, type ServiceContext } from "./context";
import { requireTeamAdmin } from "./owners";

/** 店主後台「MCP 連線」：這個網站的 OAuth 授權（同意紀錄）列表與撤銷（owner 角色或平台後台） */
export async function listOAuthGrantsForTenant(ctx: ServiceContext, input: { site?: string | null }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const rows = await ctx.store.listOAuthGrants({ tenantId: tenant.id, limit: 100 });
  const out = [];
  for (const g of rows) {
    const [c, u] = await Promise.all([ctx.store.getOAuthClient(g.client_id), ctx.store.getOwnerUserById(g.user_id)]);
    out.push({ id: g.id, clientName: c?.client_name ?? g.client_id, clientKind: c?.kind ?? null, userEmail: u?.email ?? null, scopes: g.scopes, createdAt: g.created_at, lastUsedAt: g.last_used_at, revokedAt: g.revoked_at, revokedReason: g.revoked_reason });
  }
  return out;
}

export async function revokeOAuthGrantForTenant(ctx: ServiceContext, input: { site?: string | null; grantId: string }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const g = await ctx.store.getOAuthGrant(input.grantId);
  if (!g || g.tenant_id !== tenant.id) throw new ServiceError("not_found", "找不到這個授權");
  await ctx.store.revokeOAuthGrant(g.id, `revoked_by:${ctx.actor.label}`);
  await audit(ctx, tenant.id, "oauth.revoke", { grantId: g.id });
  return { id: g.id, revoked: true };
}
