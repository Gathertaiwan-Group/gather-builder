import type { SiteContent } from "./content";
import { verifyPreviewToken } from "./preview";
import { getStore } from "./store";
import type { Store, TenantModuleRow, TenantRow } from "./store/types";
import { DEFAULT_LANG, isLangCode } from "./i18n/langs";

export interface LoadedSite {
  tenant: TenantRow;
  content: SiteContent;
  modules: Map<string, TenantModuleRow>;
  mode: "published" | "preview";
  revision: number | null;
  previewToken: string | null;
  /** 帶了 preview 參數但簽章無效或過期 */
  previewRejected: boolean;
  /** 目前顯示的語言（i18n；預設 zh-TW）與網站啟用的其他語言 */
  lang: string;
  languages: string[];
}

/** middleware 設定的語言（/s/<slug>/<lang>/… 改寫而來）；不在 request scope（測試、cron）時回 null */
async function requestLang(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-gb-lang");
  } catch {
    return null;
  }
}

/** 網站啟用的其他語言（i18n 模組啟用＋目前顯示內容的設定） */
export function enabledLanguages(content: SiteContent, modules: Map<string, TenantModuleRow>): string[] {
  const m = modules.get("i18n");
  if (!m || m.status === "disabled") return [];
  const langs = (content.moduleSettings?.i18n as { languages?: unknown } | undefined)?.languages;
  return Array.isArray(langs) ? langs.filter(isLangCode) : [];
}

/**
 * 前台讀取：預設讀「已發布快照」；帶有效簽章 preview token 時讀草稿。
 * 全部走 no-store 的 Supabase client（見 lib/store/supabase.ts），發布後立即生效。
 */
export async function loadSite(slug: string, previewToken?: string | null, store: Store = getStore(), opts: { lang?: string | null } = {}): Promise<LoadedSite | null> {
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant || tenant.status === "suspended") return null;
  const modules = new Map((await store.listTenantModules(tenant.id)).map((m) => [m.module_id, m]));

  let loaded: Omit<LoadedSite, "lang" | "languages"> | null = null;
  if (previewToken) {
    const secret = process.env.PREVIEW_SECRET;
    if (secret && verifyPreviewToken(previewToken, tenant.id, secret).ok) {
      const draft = await store.getDraft(tenant.id);
      if (draft) loaded = { tenant, content: draft.content, modules, mode: "preview", revision: null, previewToken, previewRejected: false };
    }
  }
  if (!loaded) {
    if (!tenant.published_revision_id) return null;
    const rev = await store.getRevision(tenant.published_revision_id);
    if (!rev) return null;
    loaded = { tenant, content: rev.content, modules, mode: "published", revision: rev.number, previewToken: null, previewRejected: !!previewToken };
  }
  const languages = enabledLanguages(loaded.content, modules);
  const want = opts.lang !== undefined ? opts.lang : await requestLang();
  // 語言前綴沒有啟用（或 i18n 沒開）→ 當作找不到頁面
  if (want && want !== DEFAULT_LANG && !languages.includes(want)) return null;
  return { ...loaded, lang: want && languages.includes(want) ? want : DEFAULT_LANG, languages };
}

export function moduleActive(site: LoadedSite, id: string): boolean {
  const m = site.modules.get(id);
  return !!m && m.status !== "disabled";
}

/** 模組設定讀「目前顯示的內容」（已發布快照或預覽中的草稿），不讀即時設定 */
export function moduleConfig<T = Record<string, unknown>>(site: LoadedSite, id: string): T {
  return (site.content.moduleSettings?.[id] ?? {}) as T;
}
