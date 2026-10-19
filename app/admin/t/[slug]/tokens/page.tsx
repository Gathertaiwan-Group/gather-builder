import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listOwnerSiteTokens } from "@/lib/services/owners";
import { listOAuthGrantsForTenant } from "@/lib/services/oauth-grants";
import { TENANT_SCOPES } from "@/lib/scopes";
import { ServiceError } from "@/lib/services/context";
import { baseUrlFrom } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** MCP 連線：手動 Bearer token（發行／撤銷）＋ OAuth 授權（列出／撤銷）。只有 owner 角色或平台後台 */
export default async function TokensPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const toks = await listOwnerSiteTokens(bo.ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? null : Promise.reject(e)));
  const grants = await listOAuthGrantsForTenant(bo.ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? null : Promise.reject(e)));
  const act = `${bo.api}/site-tokens`;
  const mcpUrl = `${baseUrlFrom(null)}/api/mcp`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/tokens" name={bo.tenant.name} />
      <Card title="用 AI agent 管理網站">
        <p className="mt-0 text-sm">
          MCP 端點：<code data-admin="mcp-url">{mcpUrl}</code>
        </p>
        <p className="text-sm">兩種連法擇一：① 支援 OAuth 的客戶端（Claude Desktop、claude.ai 自訂連接器）直接加這個網址，登入店主帳號並同意即可；② 用下方發行的 token 加 header <code>Authorization: Bearer …</code>（Claude Code：<code>claude mcp add --transport http 名稱 {mcpUrl} --header &quot;Authorization: Bearer gbt_…&quot;</code>）。</p>
      </Card>
      {toks === null ? (
        <Card title="MCP token">
          <p className="m-0 text-sm text-neutral-600">只有網站擁有者（owner）可以管理 token。</p>
        </Card>
      ) : (
        <Card title={`手動 token（${toks.length}）`}>
          <ul className="m-0 flex flex-col gap-2 p-0 text-sm" data-admin="site-tokens">
            {toks.map((t) => (
              <li key={t.id} className="list-none border-b pb-2">
                <code>{t.token_prefix}…</code> {t.name} · {t.revoked_at ? `已撤銷 ${fmt(t.revoked_at)}` : `最後使用 ${fmt(t.last_used_at)}`}
                {!t.revoked_at && (
                  <form action={act} method="post" className="ml-2 inline">
                    <input type="hidden" name="action" value="revoke" />
                    <input type="hidden" name="tokenId" value={t.id} />
                    <button className="rounded border px-2 text-xs" type="submit">撤銷</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <form action={act} method="post" className="mt-4 flex flex-col gap-2 text-sm">
            <input type="hidden" name="action" value="issue" />
            <input name="name" required placeholder="用途（例如：我的 Claude Code）" className="rounded border px-3 py-1" />
            <div className="flex flex-wrap gap-3 text-xs">
              {TENANT_SCOPES.map((s) => (
                <label key={s} className="flex items-center gap-1">
                  <input type="checkbox" name="scopes" value={s} defaultChecked={!["points:adjust", "wallet:adjust"].includes(s)} /> {s}
                </label>
              ))}
            </div>
            <div>
              <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">發行 token</button>
            </div>
          </form>
        </Card>
      )}
      {grants && (
        <Card title={`OAuth 授權（${grants.filter((g) => !g.revokedAt).length} 個有效）`}>
          <ul className="m-0 flex flex-col gap-2 p-0 text-sm" data-admin="oauth-grants">
            {grants.map((g) => (
              <li key={g.id} className="list-none border-b pb-2" data-admin="oauth-grant" data-revoked={g.revokedAt ? "1" : "0"}>
                <b>{g.clientName}</b> · {g.userEmail} · <span className="text-xs">{g.scopes.join(" ")}</span> · 授權於 {fmt(g.createdAt)} · 最後使用 {fmt(g.lastUsedAt)}
                {g.revokedAt ? (
                  <span className="text-neutral-500">
                    {" "}
                    · 已撤銷 {fmt(g.revokedAt)}
                    {g.revokedReason ? `（${g.revokedReason}）` : ""}
                  </span>
                ) : (
                  <form action={act} method="post" className="ml-2 inline">
                    <input type="hidden" name="action" value="revoke_grant" />
                    <input type="hidden" name="grantId" value={g.id} />
                    <button className="rounded border px-2 text-xs" type="submit">撤銷授權</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </AdminShell>
  );
}
