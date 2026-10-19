import type { RoutingLookup } from "./host-routing";
import type { Store } from "./store/types";

/** 以 Store 實作的路由查詢（node 端與測試用；middleware 用 lib/edge-routing.ts 直接打 PostgREST，語意相同：只認 active 網域） */
export function storeRoutingLookup(store: Store): RoutingLookup {
  return {
    async byDomain(domain) {
      const d = await store.getDomainByName(domain);
      if (!d || d.status !== "active") return null;
      const t = await store.getTenantById(d.tenant_id);
      return t ? { slug: t.slug, primaryDomain: t.primary_domain } : null;
    },
    async bySlug(slug) {
      const t = await store.getTenantBySlug(slug);
      return t ? { slug: t.slug, primaryDomain: t.primary_domain } : null;
    },
  };
}
