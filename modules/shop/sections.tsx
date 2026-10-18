import type { z } from "zod";
import { getStore } from "@/lib/store";
import { renderMarkdown } from "@/lib/markdown";
import { publicProducts, variantLabel } from "@/lib/services/shop";
import type { ProductRow, VariantRow } from "@/lib/store/types";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { productDetailProps, productGridProps } from "./manifest";
import { AddToCart } from "./AddToCart";

export const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

function minPrice(p: ProductRow, variants: VariantRow[]) {
  const prices = variants.length ? variants.map((v) => v.price ?? p.price) : [p.price];
  return Math.min(...prices);
}

export function ProductCards({ ctx, items, columns }: { ctx: RenderCtx; items: { product: ProductRow; variants: VariantRow[] }[]; columns: number }) {
  const cols = columns === 2 ? "md:grid-cols-2" : columns === 4 ? "md:grid-cols-4" : "md:grid-cols-3";
  return (
    <div className={`grid grid-cols-2 gap-4 ${cols}`}>
      {items.map(({ product: p, variants }) => {
        const soldOut = p.track_inventory && (variants.length ? variants.every((v) => v.stock <= 0) : p.stock <= 0);
        return (
          <a key={p.id} href={siteHref(ctx, `/shop/${p.slug}`)} className="gb-card block overflow-hidden text-inherit no-underline" data-gb="product-card">
            {p.images[0] ? <img src={p.images[0]} alt="" loading="lazy" className="aspect-square w-full object-cover" /> : <div className="aspect-square w-full" style={{ background: "color-mix(in srgb, var(--gb-text) 6%, transparent)" }} />}
            <div className="p-3 md:p-4">
              <h3 className="m-0 text-base font-bold">{p.name}</h3>
              <p className="m-0 mt-1 text-sm">
                {variants.length > 1 ? `${twd(minPrice(p, variants))} 起` : twd(minPrice(p, variants))}
                {p.compare_at_price && p.compare_at_price > p.price && <s className="gb-muted ml-2">{twd(p.compare_at_price)}</s>}
                {soldOut && <span className="gb-muted ml-2">售完</span>}
              </p>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export const ProductGrid: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof productGridProps>;
  const items = await publicProducts(getStore(), ctx.site.tenant.id, p.limit);
  return (
    <section className="gb-section">
      <div className="gb-container">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
          {p.heading ? <h2 className="gb-h2 m-0">{p.heading}</h2> : <span />}
          {p.showAllLink && (
            <a href={siteHref(ctx, "/shop")} className="text-sm" style={{ color: "var(--gb-primary)" }}>
              全部商品 →
            </a>
          )}
        </div>
        {items.length === 0 ? <p className="gb-muted">商品準備中。</p> : <ProductCards ctx={ctx} items={items} columns={p.columns} />}
      </div>
    </section>
  );
};

export async function ProductView({ ctx, product, variants }: { ctx: RenderCtx; product: ProductRow; variants: VariantRow[] }) {
  const soldOut = product.track_inventory && product.stock <= 0;
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2" data-gb="product-detail">
      <div className="flex flex-col gap-3">
        {product.images.length ? (
          product.images.map((src, i) => <img key={i} src={src} alt={i === 0 ? product.name : ""} className="w-full rounded-[var(--gb-radius)] object-cover" />)
        ) : (
          <div className="aspect-square w-full rounded-[var(--gb-radius)]" style={{ background: "color-mix(in srgb, var(--gb-text) 6%, transparent)" }} />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <h1 className="gb-h2 m-0">{product.name}</h1>
        {product.compare_at_price && product.compare_at_price > product.price && <s className="gb-muted">{twd(product.compare_at_price)}</s>}
        <AddToCart
          slug={ctx.site.tenant.slug}
          checkoutHref={siteHref(ctx, "/checkout")}
          product={{ id: product.id, name: product.name, price: product.price, soldOut }}
          variants={variants.map((v) => ({ id: v.id, label: variantLabel(v) ?? "預設", price: v.price ?? product.price, soldOut: product.track_inventory && v.stock <= 0 }))}
        />
        {product.description_md && <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(product.description_md) }} />}
      </div>
    </div>
  );
}

export const ProductDetail: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof productDetailProps>;
  const store = getStore();
  const product = await store.getProductBySlug(ctx.site.tenant.id, p.productSlug);
  if (!product || product.status !== "published") return null;
  const variants = await store.listVariants(ctx.site.tenant.id, [product.id]);
  return (
    <section className="gb-section">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <ProductView ctx={ctx} product={product} variants={variants} />
      </div>
    </section>
  );
};
