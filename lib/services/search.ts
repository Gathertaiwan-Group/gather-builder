import type { LoadedSite } from "../site-loader";
import { moduleActive } from "../site-loader";
import type { SearchHit, Store, TrEntityType } from "../store/types";
import { translatableFields, applyTranslations } from "../i18n/translatable";
import { localizePage, sectionTranslation } from "../i18n/render";
import { localizeRows } from "./i18n";
import { DEFAULT_LANG } from "../i18n/langs";
import { ServiceError } from "./context";

export interface SearchResult {
  kind: "page" | "post" | "product" | "event" | "course" | "person" | "document";
  title: string;
  href: string;
  snippet: string;
}

export const SEARCH_LIMIT_PER_10MIN = 60;
export const KIND_LABEL: Record<SearchResult["kind"], string> = { page: "頁面", post: "文章", product: "商品", event: "活動", course: "課程", person: "人員", document: "文件" };

/** 各命中種類需要的模組（模組沒開就不出現在結果） */
const KIND_MODULE: Record<string, string> = { post: "blog", product: "shop", event: "events", course: "courses", person: "directory", document: "downloads" };

const stripMd = (s: string) => s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#*_`>~|-]+/g, " ").replace(/\s+/g, " ").trim();

export function snippetOf(text: string, q: string, width = 80): string {
  const t = stripMd(text);
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t.slice(0, width * 2);
  const start = Math.max(0, i - width);
  return `${start > 0 ? "…" : ""}${t.slice(start, i + q.length + width)}${i + q.length + width < t.length ? "…" : ""}`;
}

function hrefFor(kind: string, slug: string | null, id: string): string {
  if (kind === "post") return `/blog/${slug}`;
  if (kind === "product") return `/shop/${slug}`;
  if (kind === "event") return `/events/${slug}`;
  if (kind === "course") return `/courses/${slug}`;
  if (kind === "person") return `/people/${slug}`;
  if (kind === "document") return `/downloads#doc-${id}`;
  return "/";
}

/** 翻譯命中（只有 id）：補回 slug／title，並確認主資料是已發布（草稿不可被搜出） */
async function resolveEntity(store: Store, tenantId: string, kind: string, id: string): Promise<{ slug: string; title: string } | null> {
  const now = new Date().toISOString();
  if (kind === "post") {
    const p = await store.getPostById(tenantId, id);
    return p && p.status === "published" && p.published_at && p.published_at <= now ? { slug: p.slug, title: p.title } : null;
  }
  if (kind === "product") {
    const p = await store.getProductById(tenantId, id);
    return p && p.status === "published" ? { slug: p.slug, title: p.name } : null;
  }
  if (kind === "event") {
    const e = await store.getEventById(tenantId, id);
    return e && e.status === "published" ? { slug: e.slug, title: e.title } : null;
  }
  if (kind === "course") {
    const c = await store.getCourseById(tenantId, id);
    return c && c.status === "published" ? { slug: c.slug, title: c.title } : null;
  }
  return null;
}

/**
 * 站內搜尋：頁面（目前顯示的快照，含目前語言的翻譯）＋模組資料（SQL builder_search_content，只搜已發布、該租戶）。
 * 課程只比對介紹與單元標題——🔴 付費單元內文不會被搜出，也不會出現在摘要。
 */
export async function searchSite(store: Store, site: LoadedSite, qRaw: string, limit = 20): Promise<{ q: string; results: SearchResult[] }> {
  const q = qRaw.trim().slice(0, 60);
  if (!q) return { q, results: [] };
  if (q.length > 60) throw new ServiceError("invalid", "關鍵字太長");
  const lq = q.toLowerCase();
  const results: SearchResult[] = [];
  // 1. 頁面：標題、SEO 描述、所有區塊的文字欄位（已套用目前語言的翻譯）
  for (const page of site.content.pages) {
    const p = localizePage(site, page);
    const texts = [p.title, p.seo?.description ?? ""];
    for (const s of page.sections) texts.push(...Object.values(translatableFields(applyTranslations(s.props, sectionTranslation(site, page.path, s.id)))));
    const all = texts.join("\n");
    if (all.toLowerCase().includes(lq)) results.push({ kind: "page", title: p.title, href: page.path, snippet: snippetOf(all, q) });
  }
  // 2. 模組資料
  const hits: SearchHit[] = await store.searchContent(site.tenant.id, q, site.lang !== DEFAULT_LANG ? site.lang : null, limit);
  const seen = new Set<string>();
  const byKind: Record<string, { id: string; slug: string; title: string; body: string }[]> = {};
  for (const h of hits) {
    const mod = KIND_MODULE[h.kind];
    if (!mod || !moduleActive(site, mod)) continue;
    const key = `${h.kind}:${h.id}`;
    if (seen.has(key)) continue;
    let slug = h.slug;
    let title = h.title;
    if (!title || (!slug && h.kind !== "document")) {
      const e = await resolveEntity(store, site.tenant.id, h.kind, h.id);
      if (!e) continue;
      slug = e.slug;
      title = e.title;
    }
    seen.add(key);
    (byKind[h.kind] ??= []).push({ id: h.id, slug: slug ?? "", title, body: h.body ?? "" });
  }
  for (const [kind, rows] of Object.entries(byKind)) {
    // 標題套用目前語言（缺翻譯維持中文）
    const loc = ["post", "product", "event", "course"].includes(kind) ? await localizeRows(store, site, kind as TrEntityType, rows.map((r) => ({ id: r.id, title: r.title, name: r.title }))) : rows;
    rows.forEach((r, i) => {
      const l = loc[i] as { title?: string; name?: string };
      results.push({ kind: kind as SearchResult["kind"], title: (kind === "product" ? l.name : l.title) ?? r.title, href: hrefFor(kind, r.slug, r.id), snippet: snippetOf(r.body || r.title, q) });
    });
  }
  return { q, results: results.slice(0, limit) };
}
