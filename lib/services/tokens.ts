import { generateToken } from "../tokens";
import { ALL_SCOPES, TENANT_SCOPES, isScope, type Scope } from "../scopes";
import { ServiceError, audit, requirePlatform, type ServiceContext } from "./context";

/**
 * 發行 MCP token。原文只在回傳值出現一次，DB 只存 sha256。
 * - site 有值：租戶 token，scopes 不能含 platform:sites。
 * - site 為空：平台 token，只有後台（admin）能發。
 */
export async function issueToken(ctx: ServiceContext, input: { site?: string | null; name: string; scopes: string[] }) {
  requirePlatform(ctx);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ServiceError("invalid", "token 名稱必填");
  const bad = input.scopes.filter((s) => !isScope(s));
  if (bad.length) throw new ServiceError("invalid", `未知 scope：${bad.join(", ")}。可用：${ALL_SCOPES.join(", ")}`);
  const scopes = [...new Set(input.scopes)] as Scope[];
  if (!scopes.length) throw new ServiceError("invalid", "至少要選一個 scope");
  // 不能發出比自己大的 token
  const exceeding = scopes.filter((s) => !ctx.actor.scopes.includes(s));
  if (exceeding.length) throw new ServiceError("forbidden", `不能發行超出自己權限的 token：你沒有 ${exceeding.join(", ")}`);

  let tenantId: string | null = null;
  if (input.site) {
    const t = await ctx.store.getTenantBySlug(input.site);
    if (!t) throw new ServiceError("not_found", `找不到網站「${input.site}」`);
    tenantId = t.id;
    const notAllowed = scopes.filter((s) => !TENANT_SCOPES.includes(s));
    if (notAllowed.length) throw new ServiceError("invalid", `租戶 token 不能有：${notAllowed.join(", ")}`);
  } else if (ctx.actor.kind !== "admin") {
    throw new ServiceError("forbidden", "平台級 token 只能由後台發行");
  }

  const tok = generateToken(tenantId ? "tenant" : "platform");
  const row = await ctx.store.insertToken({ tenant_id: tenantId, name, token_hash: tok.hash, token_prefix: tok.prefix, scopes });
  await audit(ctx, tenantId, "token.issue", { tokenId: row.id, name, scopes, platform: !tenantId });
  return { id: row.id, token: tok.raw, prefix: tok.prefix, scopes, site: input.site ?? null, note: "token 原文只顯示這一次。" };
}

export async function revokeToken(ctx: ServiceContext, input: { tokenId: string }) {
  requirePlatform(ctx);
  const existing = await ctx.store.getToken(input.tokenId);
  if (!existing) throw new ServiceError("not_found", "找不到 token");
  if (!existing.tenant_id && ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "平台級 token 只能由後台撤銷");
  const row = await ctx.store.revokeToken(input.tokenId);
  if (!row) throw new ServiceError("conflict", "token 已經撤銷過了");
  await audit(ctx, existing.tenant_id, "token.revoke", { tokenId: input.tokenId, name: existing.name });
  return { id: row.id, revokedAt: row.revoked_at };
}

export async function listTokens(ctx: ServiceContext, input: { tenantId: string | null | "all" }) {
  requirePlatform(ctx);
  const rows = await ctx.store.listTokens(input.tenantId);
  return rows.map(({ token_hash: _h, ...rest }) => rest);
}
