import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getStore } from "@/lib/store";
import { baseUrlFrom } from "@/lib/runtime";
import { currentOwnerSession } from "@/lib/owner/routes";
import { ownerSites } from "@/lib/services/owners";
import { oauthConfig, validateAuthorize } from "@/lib/services/oauth";
import { AUTHORIZE_PARAMS, authorizeQuery, consentToken } from "@/lib/oauth/routes";
import { SCOPES } from "@/lib/scopes";
import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "授權 AI agent｜Gather Builder", referrer: "no-referrer" as const, robots: { index: false, follow: false } };

const ROLE = { owner: "擁有者", editor: "編輯", viewer: "檢視者" } as const;

/** OAuth 2.1 授權端點（GET）：驗證請求 → 店主登入 → 選網站與權限 → 同意（POST /oauth/authorize/decision） */
export default async function Authorize({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const p = new URLSearchParams();
  for (const k of AUTHORIZE_PARAMS) {
    const v = raw[k];
    if (typeof v === "string") p.set(k, v);
  }
  const h = new Headers(await headers());
  const cfg = oauthConfig(baseUrlFrom({ headers: h }));
  const store = getStore();
  const v = await validateAuthorize(store, cfg, p);
  if (!v.ok) {
    if (v.redirect) redirect(v.redirect);
    return (
      <OwnerAuthShell title="無法授權" sp={{ err: v.error.description }}>
        <p className="text-sm text-neutral-600">這個連結有問題（{v.error.error}）。請回到你的 AI 工具重新連線。</p>
      </OwnerAuthShell>
    );
  }
  const s = await currentOwnerSession();
  if (!s) redirect(`/owner/login?next=${encodeURIComponent(`/oauth/authorize?${authorizeQuery(p)}`)}`);
  const sites = await ownerSites(store, s.user.id);
  const csrf = consentToken(s.session.id, p);
  const c = v.req.client;
  const clientHost = c.kind === "cimd" ? new URL(c.client_id).host : null;
  return (
    <OwnerAuthShell title="授權 AI agent 管理網站" sp={{}}>
      <p className="text-sm" data-oauth="client">
        <b>{c.client_name ?? "未命名的應用程式"}</b>
        {clientHost && <span className="text-neutral-500">（{clientHost}）</span>} 想要以你的身分（{s.user.email}）存取網站。
      </p>
      <p className="text-xs text-neutral-500">授權後會回到：{new URL(v.req.redirectUri).origin}</p>
      {sites.length === 0 ? (
        <p className="text-sm">你沒有可以授權的網站。</p>
      ) : (
        <form action="/oauth/authorize/decision" method="post" className="flex flex-col gap-3 text-sm" data-oauth="consent">
          {AUTHORIZE_PARAMS.map((k) => (p.get(k) !== null ? <input key={k} type="hidden" name={k} value={p.get(k)!} /> : null))}
          <input type="hidden" name="csrf" value={csrf} />
          <fieldset className="rounded border p-3">
            <legend className="px-1">選擇網站（一次授權一個網站）</legend>
            {sites.map((x, i) => (
              <label key={x.tenant.id} className="flex items-center gap-2">
                <input type="radio" name="tenant_id" value={x.tenant.id} defaultChecked={i === 0} required /> {x.tenant.name}（{x.tenant.slug}，{ROLE[x.role]}
                {x.role === "viewer" ? "：只能授權讀取權限" : ""}）
              </label>
            ))}
          </fieldset>
          <fieldset className="rounded border p-3">
            <legend className="px-1">權限（可取消勾選；超出你在該網站角色的權限會自動略過）</legend>
            {v.req.scopes.map((sc) => (
              <label key={sc} className="flex items-start gap-2">
                <input type="checkbox" name="grant_scope" value={sc} defaultChecked={!["points:adjust", "wallet:adjust"].includes(sc)} />
                <span>
                  <code>{sc}</code> <span className="text-neutral-600">{SCOPES[sc]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button name="decision" value="approve" className="rounded bg-neutral-900 px-4 py-2 text-white" type="submit" data-oauth="approve">
              同意
            </button>
            <button name="decision" value="deny" className="rounded border px-4 py-2" type="submit" data-oauth="deny">
              拒絕
            </button>
          </div>
          <p className="text-xs text-neutral-500">之後可以在店主後台「MCP 連線」隨時撤銷這個授權。</p>
        </form>
      )}
    </OwnerAuthShell>
  );
}
