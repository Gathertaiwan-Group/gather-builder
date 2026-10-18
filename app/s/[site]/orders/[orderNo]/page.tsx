import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { currentMember } from "@/lib/site-request";
import { moduleConfig } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { canViewOrder, shopSettingsSchema, type ShopSettings } from "@/lib/services/shop";
import { expireIfDue, retryOrderHooks } from "@/lib/services/orders";
import { getMailer } from "@/lib/mail";
import { baseUrlFrom } from "@/lib/runtime";
import { headers } from "next/headers";
import { ORDER_STATUS_LABEL } from "@/lib/shop/machine";
import { INVOICE_LABEL, SHIPMENT_LABEL } from "@/lib/order-labels";
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
  // M2：讀取時補做這張訂單失敗過的付款後處理（冪等）
  // 第五六批審查 L3：公開頁的補做不計次、且每張訂單每 10 分鐘最多一次（重新整理／輪詢不會灌爆失敗次數）
  const gate = await store.rateHit(`hook-retry-page:${site.tenant.id}`, found.id, 600, 1).catch(() => ({ allowed: false }));
  if (gate.allowed) await retryOrderHooks({ store, sendMail: getMailer(), baseUrl: baseUrlFrom({ headers: await headers() }) }, { orderId: found.id, countAttempts: false }).catch((e) => console.error("[hooks] lazy", e));
  const order = await expireIfDue(store, found);
  const [items, invoice, shipment] = await Promise.all([
    store.listOrderItems(site.tenant.id, order.id),
    order.invoice_status ? store.getInvoiceByOrder(site.tenant.id, order.id) : Promise.resolve(null),
    store.getActiveShipmentByOrder(site.tenant.id, order.id),
  ]);
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
            {order.discount_total > 0 && (
              <li className="flex justify-between gap-3 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
                <span>折扣{order.coupon_code ? `（${order.coupon_code}）` : ""}</span>
                <span data-gb="order-discount">−{twd(order.discount_total)}</span>
              </li>
            )}
            {!!order.tier_discount && (
              <li className="flex justify-between gap-3">
                <span>會員等級折扣</span>
                <span data-gb="order-tier-discount">−{twd(order.tier_discount)}</span>
              </li>
            )}
            {!!order.points_discount && (
              <li className="flex justify-between gap-3">
                <span>點數折抵（{order.points_redeemed} 點）</span>
                <span data-gb="order-points-discount">−{twd(order.points_discount)}</span>
              </li>
            )}
            <li className="flex justify-between gap-3 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
              <span>運費{order.shipping_choice?.label ? `（${order.shipping_choice.label}）` : ""}</span>
              <span>{twd(order.shipping_fee)}</span>
            </li>
            {!!order.wallet_paid && (
              <li className="flex justify-between gap-3">
                <span>儲值金支付</span>
                <span data-gb="order-wallet-paid">−{twd(order.wallet_paid)}</span>
              </li>
            )}
            <li className="flex justify-between gap-3 font-bold">
              <span>總計</span>
              <span data-gb="order-total">{twd(order.total)}</span>
            </li>
          </ul>
          {(invoice?.invoice_no || shipment || order.shipping_choice?.store) && (
            <div className="gb-card mt-4 flex flex-col gap-1 p-4 text-sm" data-gb="order-extra">
              {order.shipping_choice?.store && (
                <p className="m-0">
                  取貨門市：{order.shipping_choice.store.name}（{order.shipping_choice.store.address}）
                </p>
              )}
              {shipment && (
                <p className="m-0" data-gb="shipment">
                  物流：{SHIPMENT_LABEL[shipment.status] ?? shipment.status}
                  {shipment.tracking_no && <> · 追蹤號 <span data-gb="tracking-no">{shipment.tracking_no}</span></>}
                </p>
              )}
              {invoice?.invoice_no && (
                <p className="m-0" data-gb="invoice-no">
                  電子發票：{invoice.invoice_no}（{INVOICE_LABEL[invoice.status] ?? invoice.status}）
                </p>
              )}
            </div>
          )}
          <p className="mt-6 text-sm">
            <a href={siteHref(ctx, "/shop")}>← 繼續購物</a>
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
