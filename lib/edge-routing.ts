import type { DomainRouting, RoutingLookup } from "./host-routing";

/**
 * middleware（edge）用的租戶路由查詢：直接打 PostgREST（service role，只在 server 端）。
 * 結果在單一實例內快取 30 秒（命中與未命中都快取），自有網域啟用／移除最多 30 秒後生效。
 * 🔴 只認 status=active 的網域；pending／verified 的網域不會被對應到任何租戶。
 */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; v: DomainRouting | null }>();

async function rest<T>(path: string): Promise<T | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function cached(k: string, fn: () => Promise<DomainRouting | null>): Promise<DomainRouting | null> {
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const v = await fn();
  if (cache.size > 2000) cache.clear();
  cache.set(k, { at: Date.now(), v });
  return v;
}

export const edgeRoutingLookup: RoutingLookup = {
  byDomain(domain) {
    return cached(`d:${domain}`, async () => {
      const rows = await rest<{ builder_tenants: { slug: string; primary_domain: string | null } | null }[]>(
        `builder_tenant_domains?select=builder_tenants!inner(slug,primary_domain)&status=eq.active&domain=eq.${encodeURIComponent(domain)}&limit=1`,
      );
      const t = rows?.[0]?.builder_tenants;
      return t ? { slug: t.slug, primaryDomain: t.primary_domain } : null;
    });
  },
  bySlug(slug) {
    return cached(`s:${slug}`, async () => {
      const rows = await rest<{ slug: string; primary_domain: string | null }[]>(`builder_tenants?select=slug,primary_domain&slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const t = rows?.[0];
      return t ? { slug: t.slug, primaryDomain: t.primary_domain } : null;
    });
  },
};
