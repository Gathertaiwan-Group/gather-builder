/**
 * 依 Host 決定「這個 request 是平台還是某個租戶網站」（edge／node 共用，不 import node 模組）。
 *
 * 三種租戶網址都對應到同一套渲染（app/s/[site]/…）：
 * 1. 路徑模式（相容）：<平台>/s/<slug>/…
 * 2. 子網域：<slug>.<PLATFORM_SITES_DOMAIN>/…（env；例如 sites.gathertaiwan.com）
 * 3. 自有網域：builder_tenant_domains 中 status=active 的網域（DB 查詢，middleware 快取）
 *
 * 🔴 只信 `host` header（Vercel 會依實際路由的網域設定；不讀客戶端可自填的 x-forwarded-host）。
 * 🔴 平台後台、/build、OAuth、MCP、金流 callback 只在平台 host 提供；租戶 host 上一律 404。
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** 保留給平台用的子網域（不能當 slug 的子網域使用） */
export const RESERVED_SUBDOMAINS = new Set(["www", "admin", "api", "app", "mcp", "auth", "oauth", "build", "mail", "static", "assets", "cdn"]);

export type HostKind = { kind: "platform" } | { kind: "subdomain"; slug: string } | { kind: "custom"; domain: string } | { kind: "invalid" };

/** 去掉 port、轉小寫；不合法的 host 回 null */
export function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : null;
  }
  const i = h.lastIndexOf(":");
  if (i > 0) h = h.slice(0, i);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!/^[a-z0-9.-]{1,253}$/.test(h) || h.includes("..") || h.startsWith(".") || h.startsWith("-")) return null;
  return h;
}

export interface HostConfig {
  /** 平台 host（APP_URL 的 host＋PLATFORM_EXTRA_HOSTS） */
  platformHosts: string[];
  /** 子網域的根網域，例如 sites.gathertaiwan.com；null＝沒啟用子網域 */
  sitesDomain: string | null;
}

export function hostConfigFromEnv(env: Record<string, string | undefined> = process.env): HostConfig {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
  const app = env.APP_URL;
  if (app) {
    try {
      const h = normalizeHost(new URL(app).host);
      if (h) hosts.add(h);
    } catch {
      /* ignore */
    }
  }
  for (const x of (env.PLATFORM_EXTRA_HOSTS ?? "").split(",")) {
    const h = normalizeHost(x);
    if (h) hosts.add(h);
  }
  const sd = normalizeHost(env.PLATFORM_SITES_DOMAIN ?? "");
  return { platformHosts: [...hosts], sitesDomain: sd };
}

export function classifyHost(rawHost: string | null | undefined, cfg: HostConfig): HostKind {
  const host = normalizeHost(rawHost);
  if (!host) return { kind: "invalid" };
  if (cfg.platformHosts.includes(host)) return { kind: "platform" };
  // Vercel 的部署預覽網址（<專案>-<hash>.vercel.app）一律視為平台
  if (host.endsWith(".vercel.app")) return { kind: "platform" };
  if (cfg.sitesDomain) {
    if (host === cfg.sitesDomain) return { kind: "platform" };
    if (host.endsWith(`.${cfg.sitesDomain}`)) {
      const sub = host.slice(0, -(cfg.sitesDomain.length + 1));
      if (!sub.includes(".") && SLUG_RE.test(sub) && !RESERVED_SUBDOMAINS.has(sub)) return { kind: "subdomain", slug: sub };
      return { kind: "invalid" };
    }
  }
  // 純 IP 不會是租戶自有網域
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return { kind: "invalid" };
  return { kind: "custom", domain: host };
}

/** 自有網域查詢結果（middleware 用 PostgREST 查，測試注入） */
export interface DomainRouting {
  slug: string;
  /** 租戶目前的正式網域（自有網域啟用後＝那個網域）；子網域請求時若有，會 301 過去 */
  primaryDomain: string | null;
}
export type RoutingLookup = {
  byDomain(domain: string): Promise<DomainRouting | null>;
  bySlug(slug: string): Promise<DomainRouting | null>;
};

export type RouteDecision =
  | { type: "next" }
  | { type: "notfound" }
  | { type: "redirect"; location: string; status: 301 | 308 }
  /** 改寫到 app 內部路徑，並設定 x-gb-host-slug／x-gb-origin（租戶 host） */
  | { type: "rewrite"; pathname: string; slug: string; origin: string };

/** 租戶 host 上不提供的平台路徑 */
const PLATFORM_ONLY = /^\/(admin|owner|build|oauth|api|p|\.well-known|mcp)(\/|$)/;

/**
 * 純函式：依 host／路徑決定要怎麼處理。middleware 呼叫它（單元測試直接測它）。
 * - 平台 host：/s/<slug>/… 在啟用子網域後，GET 非 API、非預覽 → 301 到正式網址；其他照舊。
 * - 租戶 host：任何路徑 → /s/<slug><路徑>（已帶 /s/<自己>/ 前綴的照原樣）；平台專用路徑 404；
 *   /api/s/<自己>/… 放行，/api/s/<別人>/… 404。正式網域是自有網域時，子網域 GET → 301。
 */
export async function decideRoute(
  input: { host: string | null; pathname: string; search: string; method: string; proto: string; port: string | null },
  cfg: HostConfig,
  lookup: RoutingLookup,
): Promise<RouteDecision> {
  const hk = classifyHost(input.host, cfg);
  if (hk.kind === "invalid") return { type: "notfound" };
  const isRead = input.method === "GET" || input.method === "HEAD";
  const preview = /(^|[?&])preview=/.test(input.search);

  if (hk.kind === "platform") {
    const m = /^\/s\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])(\/.*)?$/.exec(input.pathname);
    if (!m || !isRead || preview || !cfg.sitesDomain) return { type: "next" };
    const rest = m[2] ?? "";
    if (rest.startsWith("/api") || /^\/[a-z-]+\/api(\/|$)/.test(rest)) return { type: "next" };
    const r = await lookup.bySlug(m[1]!);
    if (!r) return { type: "next" };
    const target = r.primaryDomain ? `${input.proto}://${r.primaryDomain}${portSuffix(input)}` : `${input.proto}://${m[1]}.${cfg.sitesDomain}${portSuffix(input)}`;
    return { type: "redirect", location: `${target}${rest || "/"}${input.search}`, status: 301 };
  }

  let slug: string;
  if (hk.kind === "subdomain") {
    const r = await lookup.bySlug(hk.slug);
    if (!r) return { type: "notfound" };
    slug = r.slug;
    if (r.primaryDomain && isRead && !preview && !input.pathname.includes("/api/")) {
      return { type: "redirect", location: `${input.proto}://${r.primaryDomain}${portSuffix(input)}${input.pathname}${input.search}`, status: 301 };
    }
  } else {
    const r = await lookup.byDomain(hk.domain);
    if (!r) return { type: "notfound" };
    slug = r.slug;
  }
  const origin = `${input.proto}://${normalizeHost(input.host)}${portSuffix(input)}`;
  const own = `/s/${slug}`;
  const p = input.pathname;
  if (p.startsWith("/api/s/")) {
    return p === `/api${own}` || p.startsWith(`/api${own}/`) ? { type: "rewrite", pathname: p, slug, origin } : { type: "notfound" };
  }
  if (p === own || p.startsWith(`${own}/`)) return { type: "rewrite", pathname: p, slug, origin };
  if (PLATFORM_ONLY.test(p) || p.startsWith("/s/")) return { type: "notfound" };
  return { type: "rewrite", pathname: p === "/" ? own : `${own}${p}`, slug, origin };
}

function portSuffix(input: { port: string | null; proto: string }): string {
  if (!input.port) return "";
  if ((input.proto === "https" && input.port === "443") || (input.proto === "http" && input.port === "80")) return "";
  return `:${input.port}`;
}

/** 從 host header 取 port（沒有就 null） */
export function hostPort(host: string | null | undefined): string | null {
  if (!host) return null;
  const m = /:(\d{1,5})$/.exec(host.trim());
  return m ? m[1]! : null;
}
