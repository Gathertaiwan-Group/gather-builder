import { loadSite, moduleActive, type LoadedSite } from "./site-loader";
import { resolveSiteSlug } from "./tenant-resolve";

/** 模組固定頁面（/account、/shop、/checkout、/orders）共用：網站已發布（或有效預覽）且模組已啟用 */
export async function loadModulePage(rawSlug: string, moduleId: string, preview?: string | null): Promise<LoadedSite | null> {
  const slug = resolveSiteSlug({ pathSlug: rawSlug });
  const site = slug ? await loadSite(slug, preview ?? null) : null;
  if (!site || !moduleActive(site, moduleId)) return null;
  return site;
}
