import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { loadSite } from "@/lib/site-loader";
import { findPage } from "@/lib/content";
import { resolveSiteSlug } from "@/lib/tenant-resolve";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { SectionList } from "@/components/site/SectionRenderer";
import { pageMetadata } from "@/lib/site-meta";
import { baseUrlFrom } from "@/lib/runtime";

// 前台永遠即時讀取：發布後馬上看到新版（Supabase client 另外強制 no-store）
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; path?: string[] }>; searchParams: Promise<{ preview?: string }> };

async function load(props: Props) {
  const [{ site: rawSlug, path }, { preview }] = await Promise.all([props.params, props.searchParams]);
  const h = await headers();
  const slug = resolveSiteSlug({ pathSlug: rawSlug, host: h.get("host") });
  if (!slug) return null;
  const site = await loadSite(slug, typeof preview === "string" ? preview : null);
  if (!site) return null;
  const pagePath = `/${(path ?? []).map(decodeURIComponent).join("/")}`;
  const page = findPage(site.content, pagePath);
  if (!page) return null;
  return { site, page, pagePath, base: baseUrlFrom({ headers: h }) };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到頁面" };
  return pageMetadata(r.site, r.page, `${r.base}/s/${r.site.tenant.slug}${r.pagePath === "/" ? "" : r.pagePath}`);
}

export default async function SitePage(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const ctx = makeRenderCtx(r.site, r.pagePath);
  return (
    <SiteShell ctx={ctx}>
      <SectionList sections={r.page.sections} ctx={ctx} />
    </SiteShell>
  );
}
