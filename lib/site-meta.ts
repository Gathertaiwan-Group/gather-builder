import type { Metadata } from "next";
import type { LoadedSite } from "./site-loader";
import { moduleConfig } from "./site-loader";
import type { Page } from "./content";

export function pageMetadata(site: LoadedSite, page: Pick<Page, "title" | "seo">, url: string): Metadata {
  const core = moduleConfig<{ siteDescription?: string; defaultOgImage?: string }>(site, "core");
  const title = page.seo?.title ?? (page.title === site.tenant.name ? page.title : `${page.title}｜${site.tenant.name}`);
  const description = page.seo?.description ?? core.siteDescription;
  const image = page.seo?.ogImage ?? core.defaultOgImage;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: site.mode === "preview" || site.tenant.is_test ? { index: false, follow: false } : undefined,
    openGraph: { title, description, url, siteName: site.tenant.name, type: "website", images: image ? [image] : undefined, locale: "zh_TW" },
  };
}
