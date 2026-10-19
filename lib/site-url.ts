import { normalizeHost } from "./host-routing";

/**
 * 租戶網站「正式網址」的唯一產生處（信件連結、預覽、callback 導回、sitemap、canonical、hreflang）。
 *
 * 優先序：已啟用的自有網域（builder_tenants.primary_domain）→ 子網域（<slug>.<PLATFORM_SITES_DOMAIN>）
 * → 相容的路徑模式 <平台網址>/s/<slug>。
 * 子網域／自有網域的協定與 port 跟著平台網址（本機 http://localhost:3250 → http://<slug>.<網域>:3250；正式站 https）。
 */
/** 產生網址只需要 slug 與（可選）已啟用的自有網域 */
export type SiteRef = { slug: string; primary_domain?: string | null };

export function sitesDomain(): string | null {
  return normalizeHost(process.env.PLATFORM_SITES_DOMAIN ?? "");
}

function schemeAndPort(platformBase: string): { proto: string; port: string } {
  try {
    const u = new URL(platformBase);
    const proto = u.protocol.replace(":", "");
    // 只有本機（http）才帶 port；正式站一律 https、預設 port
    if (proto === "http") return { proto, port: u.port ? `:${u.port}` : "" };
  } catch {
    /* ignore */
  }
  return { proto: "https", port: "" };
}

/** 租戶的正式 origin（沒有子網域／自有網域時回 null＝用路徑模式） */
export function tenantOrigin(tenant: SiteRef, platformBase: string): string | null {
  const { proto, port } = schemeAndPort(platformBase);
  if (tenant.primary_domain) return `${proto}://${tenant.primary_domain}${port}`;
  const sd = sitesDomain();
  if (sd) return `${proto}://${tenant.slug}.${sd}${port}`;
  return null;
}

/** 網站根網址（不帶結尾斜線），例如 https://lin-bakery.sites.gathertaiwan.com 或 https://平台/s/lin-bakery */
export function siteBase(tenant: SiteRef, platformBase: string): string {
  return tenantOrigin(tenant, platformBase) ?? `${platformBase.replace(/\/$/, "")}/s/${tenant.slug}`;
}

/** 網站內某頁的完整網址；path 以 / 開頭（可含 query） */
export function siteUrl(tenant: SiteRef, path: string, platformBase: string): string {
  const base = siteBase(tenant, platformBase);
  if (!path || path === "/") return tenantOrigin(tenant, platformBase) ? `${base}/` : base;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** 從 request header（middleware 設的 x-gb-host-slug／x-gb-origin）判斷：這個 request 是不是在租戶自己的 host 上 */
export function hostModeFor(headers: Headers, slug: string): { origin: string } | null {
  const s = headers.get("x-gb-host-slug");
  const o = headers.get("x-gb-origin");
  return s && o && s === slug ? { origin: o } : null;
}

/** request 目前所在的網站根（租戶 host＝origin；路徑模式＝<平台>/s/<slug>） */
export function requestSiteBase(headers: Headers, slug: string, platformBase: string): string {
  const hm = hostModeFor(headers, slug);
  return hm ? hm.origin : `${platformBase.replace(/\/$/, "")}/s/${slug}`;
}

/** 站內 cookie 的 path：租戶 host 上是 /（host-only、不帶 Domain），路徑模式是 /s/<slug> */
export function siteCookiePath(headers: Headers, slug: string): string {
  return hostModeFor(headers, slug) ? "/" : `/s/${slug}`;
}
