/**
 * 「這個 request 是哪個租戶」集中在這裡。
 * - 路徑模式 /s/<slug>：頁面參數直接帶 slug。
 * - 子網域 <slug>.<PLATFORM_SITES_DOMAIN> 與自有網域（builder_tenant_domains, status=active）：
 *   middleware 依 Host 解析（lib/host-routing.ts decideRoute）後改寫到 /s/<slug>/…，並設 x-gb-host-slug。
 *   所以頁面拿到的 slug 一定是 middleware 決定的那一個；租戶 host 上帶別的 /s/<slug> 會被改寫成不存在的路徑（404）。
 */
import { SLUG_RE } from "./host-routing";

export function resolveSiteSlug(input: { pathSlug?: string | null; host?: string | null }): string | null {
  const slug = input.pathSlug?.toLowerCase() ?? null;
  if (slug && SLUG_RE.test(slug)) return slug;
  return null;
}
