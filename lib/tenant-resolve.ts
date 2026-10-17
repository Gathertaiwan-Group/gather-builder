/**
 * 「這個 request 是哪個租戶」集中在這裡。
 * 第一版只認路徑 /s/<slug>；日後子網域（<slug>.builder.gather.tw）與自有網域
 * （查 builder_tenant_domains）都只改這支，頁面與服務層不用動。
 */
export function resolveSiteSlug(input: { pathSlug?: string | null; host?: string | null }): string | null {
  const slug = input.pathSlug?.toLowerCase() ?? null;
  if (slug && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return slug;
  // TODO(subdomain/custom-domain): 依 input.host 對應租戶
  return null;
}

/** 租戶網站內部連結的前綴（路徑模式為 /s/<slug>；子網域模式會是空字串） */
export function siteBasePath(slug: string): string {
  return `/s/${slug}`;
}
