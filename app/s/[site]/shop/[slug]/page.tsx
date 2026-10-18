import type { Metadata } from "next";
import { localizeProducts, localizeRow, localizeRows } from "@/lib/services/i18n";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { ProductView } from "@/modules/shop/sections";
import { siteHref } from "@/modules/render-types";
import { moduleActive } from "@/lib/site-loader";
import { ProductReviewsBlock } from "@/modules/reviews/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; slug: string }>; searchParams: Promise<{ preview?: string; ok?: string; err?: string }> };

async function load(props: Props) {
  const [{ site: raw, slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "shop", sp.preview);
  if (!site) return null;
  const store = getStore();
  const product = await localizeRow(store, site, "product", await store.getProductBySlug(site.tenant.id, slug));
  // 草稿商品只在預覽模式看得到
  if (!product || (product.status !== "published" && site.mode !== "preview")) return null;
  return { site, product, sp, variants: await store.listVariants(site.tenant.id, [product.id]) };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到商品" };
  return { title: `${r.product.name}｜${r.site.tenant.name}`, openGraph: { title: r.product.name, images: r.product.images.slice(0, 1) } };
}

export default async function ProductPage(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const ctx = makeRenderCtx(r.site, `/shop/${r.product.slug}`);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <p className="m-0 mb-4 text-sm">
            <a href={siteHref(ctx, "/shop")}>← 全部商品</a>
          </p>
          <ProductView ctx={ctx} product={r.product} variants={r.variants} />
        </div>
      </section>
      {moduleActive(r.site, "reviews") && (
        <section className="gb-section pt-0">
          <div className="gb-container max-w-3xl">
            {r.sp.ok && <p className="gb-card mb-4 p-3 text-sm" data-gb="ok">{r.sp.ok}</p>}
            {r.sp.err && <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">{r.sp.err}</p>}
            <ProductReviewsBlock ctx={ctx} product={r.product} />
          </div>
        </section>
      )}
    </SiteShell>
  );
}
