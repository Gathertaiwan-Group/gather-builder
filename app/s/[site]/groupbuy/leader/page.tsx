import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { leaderReport } from "@/lib/services/groupbuy";
import { fmtTaipei } from "@/lib/services/class-orders";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";

export const dynamic = "force-dynamic";
// 網址含簽章：不收錄、不帶 referrer
export const metadata: Metadata = { title: "團主報表", robots: { index: false, follow: false }, referrer: "no-referrer" };

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/** 團主報表（簽章連結 ?l=<團主 id>&t=<HMAC>）：只看得到自己的團與訂單；🔴 買家只顯示遮罩姓名 */
export default async function LeaderReportPage(props: { params: Promise<{ site: string }>; searchParams: Promise<{ l?: string; t?: string }> }) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "group-buy");
  if (!site) notFound();
  const r = await leaderReport(getStore(), site.tenant, sp.l, sp.t);
  if (!r) notFound();
  const ctx = makeRenderCtx(site, "/groupbuy/leader");
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">團主報表：{r.leader.name}</h1>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-gb="leader-totals">
            <p className="gb-card m-0 p-3 text-sm">訂單 <strong data-gb="leader-orders">{r.totals.orders}</strong></p>
            <p className="gb-card m-0 p-3 text-sm">已付款 <strong>{r.totals.paidOrders}</strong></p>
            <p className="gb-card m-0 p-3 text-sm">已付款金額 <strong data-gb="leader-amount">{twd(r.totals.amount)}</strong></p>
            <p className="gb-card m-0 p-3 text-sm">分潤 <strong data-gb="leader-commission">{twd(r.totals.commission)}</strong></p>
          </div>
          <h2 className="mt-6 text-base font-bold">我的團購</h2>
          <ul className="m-0 list-none p-0 text-sm">
            {r.groupBuys.map((g) => (
              <li key={g.shareUrlPath} className="gb-card mb-2 p-3">
                {g.title} · {g.status} · 截止 {fmtTaipei(g.endsAt)} · 分潤 {g.commission}
                <span className="gb-muted block break-all text-xs">專屬連結：{`/s/${site.tenant.slug}${g.shareUrlPath}`}</span>
              </li>
            ))}
          </ul>
          <h2 className="mt-6 text-base font-bold">訂單（買家資料已遮罩）</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-gb="leader-table">
              <thead>
                <tr>
                  <th className="p-2">訂單</th>
                  <th className="p-2">團購</th>
                  <th className="p-2">時間</th>
                  <th className="p-2">買家</th>
                  <th className="p-2">件數</th>
                  <th className="p-2">金額</th>
                  <th className="p-2">分潤</th>
                  <th className="p-2">狀態</th>
                  <th className="p-2">出貨</th>
                </tr>
              </thead>
              <tbody>
                {r.orders.map((o) => (
                  <tr key={o.orderNo} data-gb="leader-row">
                    <td className="p-2">{o.orderNo}</td>
                    <td className="p-2">{o.groupBuy}</td>
                    <td className="p-2">{fmtTaipei(o.createdAt, false)}</td>
                    <td className="p-2" data-gb="leader-buyer">{o.buyer}</td>
                    <td className="p-2">{o.qty}</td>
                    <td className="p-2">{twd(o.amount)}</td>
                    <td className="p-2">{twd(o.commission)}</td>
                    <td className="p-2">{o.statusLabel}</td>
                    <td className="p-2">{o.shipping}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="gb-muted mt-4 text-xs">分潤以商品實付金額（扣除折扣）計算，訂單取消會沖回。請勿轉傳本頁連結。</p>
        </div>
      </section>
    </SiteShell>
  );
}
