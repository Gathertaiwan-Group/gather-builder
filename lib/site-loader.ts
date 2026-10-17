import type { SiteContent } from "./content";
import { verifyPreviewToken } from "./preview";
import { getStore } from "./store";
import type { TenantModuleRow, TenantRow } from "./store/types";

export interface LoadedSite {
  tenant: TenantRow;
  content: SiteContent;
  modules: Map<string, TenantModuleRow>;
  mode: "published" | "preview";
  revision: number | null;
  previewToken: string | null;
  /** 帶了 preview 參數但簽章無效或過期 */
  previewRejected: boolean;
}

/**
 * 前台讀取：預設讀「已發布快照」；帶有效簽章 preview token 時讀草稿。
 * 全部走 no-store 的 Supabase client（見 lib/store/supabase.ts），發布後立即生效。
 */
export async function loadSite(slug: string, previewToken?: string | null): Promise<LoadedSite | null> {
  const store = getStore();
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant || tenant.status === "suspended") return null;
  const modules = new Map((await store.listTenantModules(tenant.id)).map((m) => [m.module_id, m]));

  if (previewToken) {
    const secret = process.env.PREVIEW_SECRET;
    if (secret && verifyPreviewToken(previewToken, tenant.id, secret).ok) {
      const draft = await store.getDraft(tenant.id);
      if (draft) return { tenant, content: draft.content, modules, mode: "preview", revision: null, previewToken, previewRejected: false };
    }
  }
  if (!tenant.published_revision_id) return null;
  const rev = await store.getRevision(tenant.published_revision_id);
  if (!rev) return null;
  return { tenant, content: rev.content, modules, mode: "published", revision: rev.number, previewToken: null, previewRejected: !!previewToken };
}

export function moduleActive(site: LoadedSite, id: string): boolean {
  const m = site.modules.get(id);
  return !!m && m.status !== "disabled";
}

export function moduleConfig<T = Record<string, unknown>>(site: LoadedSite, id: string): T {
  return (site.modules.get(id)?.config ?? {}) as T;
}
