import type { z } from "zod";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { eligibleOrders, productReviewSummary } from "@/lib/services/reviews";
import type { ProductRow } from "@/lib/store/types";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { productReviewsProps } from "./manifest";

const stars = (n: number) => "★★★★★".slice(0, Math.round(n)) + "☆☆☆☆☆".slice(0, 5 - Math.round(n));

/**
 * 商品評價：平均分＋已公開評價（內文純文字，React 自動轉義；圖片已在送出時檢查白名單）。
 * 已登入且有符合資格的訂單時顯示評價表單。
 */
export async function ProductReviewsBlock({ ctx, product, limit = 10, heading }: { ctx: RenderCtx; product: Pick<ProductRow, "id" | "slug">; limit?: number; heading?: string }) {
  const store = getStore();
  const s = await productReviewSummary(store, ctx.site.tenant, product.id, limit);
  const member = ctx.site.mode === "published" || ctx.site.mode === "preview" ? await currentMember(ctx.site.tenant) : null;
  const eligible = member ? await eligibleOrders(store, ctx.site.tenant, member, product.id) : [];
  return (
    <div className="flex flex-col gap-4" data-gb="reviews">
      <h2 className="gb-h2 m-0">{heading ?? "顧客評價"}</h2>
      <p className="m-0" data-gb="review-average">
        {s.average === null ? "還沒有評價" : (
          <>
            <span aria-hidden style={{ color: "#f59e0b" }}>{stars(s.average)}</span> {s.average} / 5（{s.count} 則）
          </>
        )}
      </p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {s.reviews.map((r) => (
          <li key={r.id} className="gb-card p-4 text-sm" data-gb="review">
            <span aria-label={`${r.rating} 星`} style={{ color: "#f59e0b" }}>{stars(r.rating)}</span> <strong>{r.name}</strong>
            {r.body && <p className="m-0 mt-2 whitespace-pre-line">{r.body}</p>}
            {r.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {r.images.map((u, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={u} alt="評價照片" loading="lazy" referrerPolicy="no-referrer" className="h-20 w-20 rounded object-cover" />
                ))}
              </div>
            )}
            {r.reply && <p className="gb-muted m-0 mt-2 whitespace-pre-line border-l-2 pl-3">店家回覆：{r.reply}</p>}
          </li>
        ))}
      </ul>
      {eligible.length > 0 && (
        <form method="post" action={`/s/${ctx.site.tenant.slug}/api/reviews`} className="gb-card flex flex-col gap-3 p-4 text-sm" data-gb="review-form">
          <strong>寫評價</strong>
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="productSlug" value={product.slug} />
          <label className="flex flex-col gap-1">
            訂單
            <select name="orderId" className="gb-input">
              {eligible.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.order_no}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            星等
            <select name="rating" className="gb-input" defaultValue="5">
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} 星
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            心得（選填）
            <textarea name="body" maxLength={2000} rows={3} className="gb-input" />
          </label>
          <label className="flex flex-col gap-1">
            圖片網址（選填，每行一個）
            <textarea name="images" maxLength={2000} rows={2} className="gb-input" />
          </label>
          <button className="gb-btn self-start" type="submit">
            送出評價
          </button>
        </form>
      )}
      {!member && <p className="gb-muted m-0 text-sm">購買過的會員<a href={siteHref(ctx, `/account/login?next=/shop/${product.slug}`)}>登入</a>後可以評價。</p>}
    </div>
  );
}

export const ProductReviews: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof productReviewsProps>;
  const product = await getStore().getProductBySlug(ctx.site.tenant.id, p.productSlug);
  if (!product || product.status !== "published") return null;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        <ProductReviewsBlock ctx={ctx} product={product} limit={p.limit} heading={p.heading} />
      </div>
    </section>
  );
};
