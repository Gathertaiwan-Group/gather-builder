import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { currentMember } from "@/lib/site-request";
import { moduleConfig } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { canViewOrder, shopSettingsSchema, type ShopSettings } from "@/lib/services/shop";
import { expireIfDue } from "@/lib/services/orders";
import { ORDER_STATUS_LABEL } from "@/lib/shop/machine";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { OrderClient } from "@/modules/shop/OrderClient";
import { twd } from "@/modules/shop/sections";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
// 網址含訂單存取金鑰：不收錄、不帶 referrer
export const metadata: Metadata = { title: "訂單狀態", robots: { index: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ site: string; orderNo: string }>; searchParams: Promise<{ k?: string; placed?: string }> };

/**
 * 訂單狀態頁（也是 PChomePay 的 return_url）：只顯示狀態、待付款時輪詢；
 * 🔴 不在這裡改任何狀態——付款只認 notify 回查的權威結果。
 */
export default async function OrderPage(props: Props) {
  const [{ site: raw, orderNo }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "shop");
  if (!site) notFound();
  const store = getStore();
  let no = orderNo;
  try {
    no = decodeURIComponent(orderNo);
  } catch {
    notFound();
  }
  if (!/^[A-Z0-9]{2,8}-\d{8}-\d{4,}$/.test(no)) notFound();
  const found = await store.getOrderByNo(site.tenant.id, no);
  const member = await currentMember(site.tenant);
  if (!found || !canViewOrder(found, sp.k, member)) notFound();
  const order = await expireIfDue(store, found);
  const items = await store.listOrderItems(site.tenant.id, order.id);
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  const settings = (parsed.success ? parsed.data : {}) as ShopSettings;
  const ctx = makeRenderCtx(site, `/orders/${order.order_no}`);
  const pending = order.status === "pending_payment";
  return (
    <SiteShell ctx={ctx}>
      <OrderClient slug={site.tenant.slug} clearCart={sp.placed === "1"} poll={pending && order.payment_method === "pchomepay"} />
      <section className="gb-section">
        <div className="gb-container max-w-2xl">
          <h1 className="gb-h2">訂單 {order.order_no}</h1>
          <p className="gb-card p-4 text-lg font-bold" data-gb="order-status" data-status={order.status}>
            {ORDER_STATUS_LABEL[order.status]}
            {order.status === "cancelled" && order.cancel_reason === "expired" && <span className="gb-muted ml-2 text-sm font-normal">（逾期未付款，已自動取消）</span>}
          </p>
          {pending && order.payment_method === "offline" && (
            <div className="gb-card mt-4 p-4 text-sm">
              <p className="m-0 font-bold">匯款資訊</p>
              <p className="m-0 mt-2 whitespace-pre-line">{settings.offlineTransfer?.instructions ?? "店家將與你聯繫付款方式。"}</p>
              {order.expires_at && <p className="gb-muted m-0 mt-2">請於 {new Date(order.expires_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })} 前完成付款。</p>}
            </div>
          )}
          {pending && order.payment_method === "pchomepay" && <p className="gb-muted mt-4 text-sm">等待金流確認付款中，頁面會自動更新。若尚未付款，請重新下單。</p>}
          <ul className="gb-card m-0 mt-4 flex list-none flex-col gap-2 p-4 text-sm" data-gb="order-items">
            {items.map((i) => (
              <li key={i.id} className="flex justify-between gap-3">
                <span>
                  {i.name}
                  {i.variant_label && `（${i.variant_label}）`} × {i.qty}
                </span>
                <span>{twd(i.line_total)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
              <span>運費</span>
              <span>{twd(order.shipping_fee)}</span>
            </li>
            <li className="flex justify-between gap-3 font-bold">
              <span>總計</span>
              <span data-gb="order-total">{twd(order.total)}</span>
            </li>
          </ul>
          <p className="mt-6 text-sm">
            <a href={siteHref(ctx, "/shop")}>← 繼續購物</a>
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
