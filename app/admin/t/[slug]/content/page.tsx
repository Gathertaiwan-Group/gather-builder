import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { getPage, getSite, listSectionTypes } from "@/lib/services/sites";
import { previewChanges } from "@/lib/services/publish";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

/** 內容編輯（店主後台與平台後台共用）：逐區塊編輯 props（JSON，依模組 schema 驗證）→ 只進草稿 → 預覽 → 到總覽發布 */
export default async function ContentEditor({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; path?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const site = await getSite(ctx, slug);
  const path = sp.path && site.pages.some((p) => p.path === sp.path) ? sp.path : "/";
  const [page, types, pv] = await Promise.all([
    getPage(ctx, { site: slug, path }),
    listSectionTypes(ctx, slug),
    previewChanges(ctx, { site: slug, path }).catch((e) => (e instanceof ServiceError ? null : Promise.reject(e))),
  ]);
  const act = `${bo.api}/content`;
  const readOnly = bo.role === "viewer";
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/content" name={site.name} />
      <Card title="頁面">
        <nav className="flex flex-wrap gap-2 text-sm">
          {site.pages.map((p) => (
            <a key={p.path} href={`${bo.base}/content?path=${encodeURIComponent(p.path)}`} aria-current={p.path === path ? "page" : undefined} className="rounded border px-2 py-0.5 no-underline">
              {p.title}（{p.path}）
            </a>
          ))}
        </nav>
        <p className="mb-0 text-sm text-neutral-600">
          修改只會進草稿。{pv && <a href={pv.previewUrl} data-admin="preview-link">預覽草稿</a>} · 確認後到 <a href={bo.base}>總覽</a> 發布。
        </p>
      </Card>
      {page.sections.map((s) => (
        <Card key={s.id} title={`${s.type}（${s.id}）`}>
          <form action={act} method="post" className="flex flex-col gap-2 text-sm" data-admin="section-form">
            <input type="hidden" name="action" value="update" />
            <input type="hidden" name="path" value={path} />
            <input type="hidden" name="sectionId" value={s.id} />
            <textarea name="props" rows={Math.min(16, JSON.stringify(s.props, null, 2).split("\n").length + 1)} defaultValue={JSON.stringify(s.props, null, 2)} className="rounded border p-2 font-mono text-xs" readOnly={readOnly} />
            {!readOnly && (
              <div className="flex gap-2">
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">儲存到草稿</button>
              </div>
            )}
          </form>
          {!readOnly && (
            <form action={act} method="post" className="mt-2 flex items-center gap-2 text-xs">
              <input type="hidden" name="action" value="remove" />
              <input type="hidden" name="path" value={path} />
              <input type="hidden" name="sectionId" value={s.id} />
              <label className="flex items-center gap-1">
                <input type="checkbox" name="confirm" required /> 確認
              </label>
              <button className="rounded border px-2 py-0.5" type="submit">移除這個區塊</button>
            </form>
          )}
        </Card>
      ))}
      {!readOnly && (
        <Card title="新增區塊">
          <form action={act} method="post" className="flex flex-col gap-2 text-sm">
            <input type="hidden" name="action" value="add" />
            <input type="hidden" name="path" value={path} />
            <select name="type" className="rounded border px-2 py-1">
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}（{t.type}）
                </option>
              ))}
            </select>
            <textarea name="props" rows={4} placeholder='{"heading":"標題"}（留空用預設值）' className="rounded border p-2 font-mono text-xs" />
            <div>
              <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">新增到草稿</button>
            </div>
          </form>
        </Card>
      )}
    </AdminShell>
  );
}
