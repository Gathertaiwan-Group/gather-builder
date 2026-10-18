import type { Metadata } from "next";
import type { LoadedSite } from "./site-loader";
import { moduleConfig } from "./site-loader";
import type { Page } from "./content";
import { DEFAULT_LANG, ogLocale } from "./i18n/langs";
import { localizePage } from "./i18n/render";

/**
 * 頁面 metadata。url＝預設語言的完整網址（https://…/s/<slug>/<path>）；
 * 多語網站加 canonical（目前語言）＋ hreflang（每個語言＋x-default）。
 */
export function pageMetadata(site: LoadedSite, pageIn: Pick<Page, "path" | "title" | "seo">, url: string): Metadata {
  const page = localizePage(site, pageIn);
  const u = new URL(url);
  const prefix = `/s/${site.tenant.slug}`;
  const rest = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
  const href = (l: string) => `${u.origin}${prefix}${l === DEFAULT_LANG ? "" : `/${l}`}${rest}`;
  const languages = site.languages.length ? Object.fromEntries([["zh-Hant-TW", href(DEFAULT_LANG)], ...site.languages.map((l) => [l, href(l)]), ["x-default", href(DEFAULT_LANG)]]) : undefined;
  url = href(site.lang);
  const core = moduleConfig<{ siteDescription?: string; defaultOgImage?: string }>(site, "core");
  const title = page.seo?.title ?? (page.title === site.tenant.name ? page.title : `${page.title}｜${site.tenant.name}`);
  const description = page.seo?.description ?? core.siteDescription;
  const image = page.seo?.ogImage ?? core.defaultOgImage;
  return {
    title,
    description,
    alternates: { canonical: url, languages },
    robots: site.mode === "preview" || site.tenant.is_test ? { index: false, follow: false } : undefined,
    openGraph: { title, description, url, siteName: site.tenant.name, type: "website", images: image ? [image] : undefined, locale: ogLocale(site.lang) },
  };
}
