import type { Page } from "../content";
import type { LoadedSite } from "../site-loader";
import { DEFAULT_LANG } from "./langs";

/** 目前語言的頁面翻譯（預設語言或沒有翻譯回 null） */
export function pageTranslation(site: Pick<LoadedSite, "lang" | "content">, path: string) {
  if (!site.lang || site.lang === DEFAULT_LANG) return null;
  return site.content.translations?.[site.lang]?.pages?.[path] ?? null;
}

/** 頁面標題／SEO 套用翻譯（缺翻譯 fallback 預設語言） */
export function localizePage<P extends Pick<Page, "path" | "title" | "seo">>(site: Pick<LoadedSite, "lang" | "content">, page: P): P {
  const tr = pageTranslation(site, page.path);
  if (!tr) return page;
  return {
    ...page,
    title: tr.title?.t || page.title,
    seo: { ...page.seo, title: tr.seoTitle?.t || (tr.title?.t && page.seo?.title ? tr.title.t : page.seo?.title), description: tr.seoDescription?.t || page.seo?.description },
  };
}

/** 區塊的翻譯（欄位路徑 → 譯文） */
export function sectionTranslation(site: Pick<LoadedSite, "lang" | "content">, path: string, sectionId: string): Record<string, string> | undefined {
  const tr = pageTranslation(site, path);
  const s = tr?.sections?.[sectionId];
  if (!s) return undefined;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.t]));
}
