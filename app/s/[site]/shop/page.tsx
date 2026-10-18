import type { Metadata } from "next";
import { localizeProducts, localizeRow, localizeRows } from "@/lib/services/i18n";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { publicProducts } from "@/lib/services/shop";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { ProductCards } from "@/modules/shop/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "shop", sp.preview);
  return { title: site ? `商品｜${site.tenant.name}` : "找不到頁面" };
}

export default async function ShopIndex(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "shop", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/shop");
  const items = await localizeProducts(getStore(), site, await publicProducts(getStore(), site.tenant.id, 100));
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">全部商品</h1>
          {items.length === 0 ? <p className="gb-muted">商品準備中。</p> : <ProductCards ctx={ctx} items={items} columns={3} />}
        </div>
      </section>
    </SiteShell>
  );
}
