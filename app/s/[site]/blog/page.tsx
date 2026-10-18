import type { Metadata } from "next";
import { localizeRow, localizeRows } from "@/lib/services/i18n";
import { notFound } from "next/navigation";
import { loadSite, moduleActive, moduleConfig } from "@/lib/site-loader";
import { resolveSiteSlug } from "@/lib/tenant-resolve";
import { getStore } from "@/lib/store";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { siteHref } from "@/modules/render-types";
import { formatDate } from "@/modules/blog/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string; page?: string }> };

async function load(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const slug = resolveSiteSlug({ pathSlug: raw });
  const site = slug ? await loadSite(slug, sp.preview ?? null) : null;
  if (!site || !moduleActive(site, "blog")) return null;
  return { site, page: Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1) };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到頁面" };
  const cfg = moduleConfig<{ listTitle?: string }>(r.site, "blog");
  return { title: `${cfg.listTitle ?? "最新消息"}｜${r.site.tenant.name}` };
}

export default async function BlogIndex(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const cfg = moduleConfig<{ listTitle?: string; postsPerPage?: number }>(r.site, "blog");
  const per = cfg.postsPerPage ?? 10;
  const listed = await getStore().listPosts(r.site.tenant.id, {
    status: "published",
    limit: per,
    offset: (r.page - 1) * per,
    publishedBefore: new Date().toISOString(),
  });
  const total = listed.total;
  const rows = await localizeRows(getStore(), r.site, "post", listed.rows);
  const pages = Math.max(1, Math.ceil(total / per));
  const ctx = makeRenderCtx(r.site, "/blog");
  const pageHref = (n: number) => {
    const base = siteHref(ctx, "/blog");
    return n === 1 ? base : `${base}${base.includes("?") ? "&" : "?"}page=${n}`;
  };
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <h1 className="gb-h2">{cfg.listTitle ?? "最新消息"}</h1>
          {rows.length === 0 && <p className="gb-muted">目前還沒有文章。</p>}
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {rows.map((p) => (
              <li key={p.id}>
                <a href={siteHref(ctx, `/blog/${p.slug}`)} className="gb-card flex flex-col gap-1 p-5 text-inherit no-underline" data-gb="post-card">
                  <time className="gb-muted text-xs">{formatDate(p.published_at)}</time>
                  <strong className="text-lg">{p.title}</strong>
                  {p.excerpt && <span className="gb-muted text-sm">{p.excerpt}</span>}
                </a>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="分頁" className="mt-8 flex flex-wrap gap-2">
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <a key={n} href={pageHref(n)} aria-current={n === r.page ? "page" : undefined} className="gb-card px-3 py-1 no-underline" style={{ color: n === r.page ? "var(--gb-primary)" : "inherit", fontWeight: n === r.page ? 700 : 400 }}>
                  {n}
                </a>
              ))}
            </nav>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
