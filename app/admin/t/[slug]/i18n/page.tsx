import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listTranslationStatus } from "@/lib/services/i18n";
import { ServiceError } from "@/lib/services/context";
import { langLabel } from "@/lib/i18n/langs";

export const dynamic = "force-dynamic";

/** 多語：翻譯進度、AI 翻譯按鈕（進草稿）、發布模組資料翻譯 */
export default async function I18nAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const r = await listTranslationStatus(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const act = `${bo.api}/i18n/action`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/i18n" name={tenant.name} />
      {"error" in r ? (
        <Card title="多語">
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        </Card>
      ) : r.languages.length === 0 ? (
        <Card title="多語">
          <p className="m-0 text-sm text-neutral-600">尚未開啟其他語言：用 MCP configure_module i18n {"{ languages: [\"en\"] }"}。</p>
        </Card>
      ) : (
        r.languages.map((L) => (
          <Card key={L.lang} title={`${langLabel(L.lang)}（${L.lang}）`}>
            <ul className="m-0 text-sm" data-admin="i18n-pages">
              {L.pages.map((p) => (
                <li key={p.path} className="flex flex-wrap items-center gap-2 py-1">
                  <span>
                    {p.path} · {p.translated}/{p.fields} 欄已翻譯{p.ai ? `（AI ${p.ai}）` : ""}
                  </span>
                  <form action={act} method="post" className="inline">
                    <input type="hidden" name="action" value="translate_page" />
                    <input type="hidden" name="lang" value={L.lang} />
                    <input type="hidden" name="path" value={p.path} />
                    <button className="rounded border px-2 py-0.5 text-xs" type="submit">AI 翻譯（進草稿）</button>
                  </form>
                </li>
              ))}
            </ul>
            <p className="mb-1 mt-3 text-xs text-neutral-600">頁面翻譯在草稿，到「總覽」預覽後發布才上線。文章／商品／活動／課程的翻譯草稿：{L.unpublishedEntityDrafts} 筆未發布。</p>
            <form action={act} method="post" className="flex items-center gap-2 text-sm">
              <input type="hidden" name="action" value="publish_entities" />
              <input type="hidden" name="lang" value={L.lang} />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="confirm" required /> 確認
              </label>
              <button className="rounded border px-3 py-1" type="submit">發布模組資料翻譯</button>
            </form>
          </Card>
        ))
      )}
    </AdminShell>
  );
}
