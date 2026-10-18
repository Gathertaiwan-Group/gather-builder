import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { loadModulePage } from "@/lib/site-page";
import { moduleConfig } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { SearchForm } from "@/modules/search/sections";
import { siteHref } from "@/modules/render-types";
import { KIND_LABEL, SEARCH_LIMIT_PER_10MIN, searchSite } from "@/lib/services/search";
import { hashIp } from "@/lib/services/inquiries";
import { requireSecret } from "@/lib/secrets";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "搜尋", robots: { index: false, follow: true } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ q?: string; preview?: string }> };

export default async function SearchPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "search", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/search");
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 60);
  let results: Awaited<ReturnType<typeof searchSite>>["results"] = [];
  let limited = false;
  if (q) {
    const h = await headers();
    const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || h.get("x-real-ip") || "unknown";
    const hit = await getStore().rateHit(`search:${site.tenant.id}`, hashIp(ip, requireSecret("PREVIEW_SECRET")), 600, SEARCH_LIMIT_PER_10MIN);
    if (!hit.allowed) limited = true;
    else results = (await searchSite(getStore(), site, q)).results;
  }
  const s = moduleConfig<{ placeholder?: string }>(site, "search");
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <h1 className="gb-h2">搜尋</h1>
          <SearchForm action={siteHref(ctx, "/search")} placeholder={s.placeholder} q={q} previewToken={site.mode === "preview" ? site.previewToken : null} />
          {limited && (
            <p role="alert" className="mt-4 text-sm" style={{ color: "#b91c1c" }}>
              搜尋太頻繁，請稍後再試。
            </p>
          )}
          {q && !limited && (
            <div className="mt-6" data-gb="search-results">
              <p className="gb-muted text-sm">「{q}」共 {results.length} 筆結果</p>
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {results.map((r, i) => (
                  <li key={i} className="gb-card p-4" data-gb="search-result" data-kind={r.kind}>
                    <span className="gb-muted text-xs">{KIND_LABEL[r.kind]}</span>
                    <a href={siteHref(ctx, r.href)} className="block text-lg font-bold">
                      {r.title}
                    </a>
                    <p className="gb-muted m-0 mt-1 text-sm">{r.snippet}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
