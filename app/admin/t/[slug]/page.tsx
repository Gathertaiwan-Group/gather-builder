import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getSite } from "@/lib/services/sites";
import { listRevisions, previewChanges } from "@/lib/services/publish";
import { listInquiries } from "@/lib/services/inquiries";
import { listTokens } from "@/lib/services/tokens";
import { getTenantBySlugAdmin, listAuditLog } from "@/lib/services/admin";
import { TENANT_SCOPES } from "@/lib/scopes";
import { ServiceError } from "@/lib/services/context";
import { TokenTable } from "@/components/admin/TokenTable";

export const dynamic = "force-dynamic";

export default async function TenantPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const [site, pv, revs, inq, toks, logs] = await Promise.all([
    getSite(ctx, slug),
    previewChanges(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? null : Promise.reject(e))),
    listRevisions(ctx, { site: slug }),
    listInquiries(ctx, { site: slug, limit: 50 }),
    listTokens(ctx, { tenantId: tenant.id }),
    listAuditLog(ctx, { tenantId: tenant.id, limit: 50 }),
  ]);
  return (
    <AdminShell sp={sp}>
      <h1 className="mb-1 mt-0 text-2xl font-bold">
        {site.name} <span className="text-base font-normal text-neutral-500">/{site.slug}</span>
      </h1>
      <p className="mb-6 mt-0 text-sm text-neutral-600">
        狀態 {site.status} · 已發布版本 {site.publishedRevision ?? "無"} · <a href={site.publicUrl}>前台</a>
        {pv && (
          <>
            {" "}
            · <a href={pv.previewUrl}>預覽草稿</a>
          </>
        )}
      </p>

      <Card title="草稿 vs 已發布">
        <p className="mt-0 text-sm">{site.draftHasUnpublishedChanges ? "草稿有未發布的變更：" : "草稿與已發布版本相同。"}</p>
        {pv && pv.changes.length > 0 && (
          <ul className="text-sm" data-admin="diff">
            {pv.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
        {pv && pv.validationErrors.length > 0 && <p className="text-sm text-red-700">發布前需修正：{pv.validationErrors.join("；")}</p>}
        <form action={`/api/admin/tenants/${slug}/publish`} method="post" className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <input name="note" placeholder="版本備註" className="rounded border px-3 py-1" />
          {pv && <input type="hidden" name="draftVersion" value={pv.draftVersion} />}
          <label className="flex items-center gap-1">
            <input type="checkbox" name="confirm" required /> 我已預覽並確認
          </label>
          <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
            發布
          </button>
        </form>
      </Card>

      <Card title={`版本（${revs.length}）`}>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-1 pr-3">#</th>
              <th className="py-1 pr-3">備註</th>
              <th className="py-1 pr-3">發布者</th>
              <th className="py-1 pr-3">時間</th>
              <th className="py-1 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {revs.map((r) => (
              <tr key={r.number} className="border-t" data-admin="revision-row">
                <td className="py-1 pr-3">
                  {r.number}
                  {r.isCurrent && <span className="ml-1 rounded bg-green-100 px-1 text-xs">上線中</span>}
                </td>
                <td className="py-1 pr-3">{r.note ?? ""}</td>
                <td className="py-1 pr-3 break-all">{r.publishedBy}</td>
                <td className="py-1 pr-3">{fmt(r.publishedAt)}</td>
                <td className="py-1 pr-3">
                  {!r.isCurrent && (
                    <form action={`/api/admin/tenants/${slug}/rollback`} method="post" className="flex items-center gap-1">
                      <input type="hidden" name="number" value={r.number} />
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" name="confirm" required />確認
                      </label>
                      <button type="submit" className="underline">
                        還原
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="模組">
        <ul className="m-0 flex flex-wrap gap-2 p-0 text-sm">
          {site.modules.map((m) => (
            <li key={m.id} className="list-none rounded border px-2 py-1">
              {m.id} · {m.status}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`詢問收件匣（${inq.length}）`}>
        {inq.length === 0 ? (
          <p className="m-0 text-sm text-neutral-500">沒有詢問。</p>
        ) : (
          <ul className="m-0 flex flex-col gap-3 p-0">
            {inq.map((q) => (
              <li key={q.id} className="list-none rounded border p-3 text-sm">
                <strong>{q.name}</strong> &lt;{q.email}&gt; {q.phone ?? ""} · {fmt(q.createdAt)} · {q.page ?? ""}
                <p className="mb-0 mt-1 whitespace-pre-line">{q.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="MCP Token">
        <TokenTable tokens={toks} />
        <form action="/api/admin/tokens" method="post" className="mt-4 flex flex-col gap-2 text-sm">
          <input type="hidden" name="site" value={slug} />
          <input name="name" required placeholder="用途（例如：客戶的 Claude）" className="rounded border px-3 py-1" />
          <div className="flex flex-wrap gap-3">
            {TENANT_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="checkbox" name="scopes" value={s} defaultChecked /> {s}
              </label>
            ))}
          </div>
          <div>
            <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
              發行 token
            </button>
          </div>
        </form>
      </Card>

      <Card title="稽核紀錄（最近 50 筆）">
        <ul className="m-0 p-0 text-xs">
          {logs.map((l) => (
            <li key={l.id} className="list-none border-t py-1 break-all">
              {fmt(l.at)} · <strong>{l.action}</strong> · {l.actor} · <code>{JSON.stringify(l.payload).slice(0, 200)}</code>
            </li>
          ))}
        </ul>
      </Card>
    </AdminShell>
  );
}

