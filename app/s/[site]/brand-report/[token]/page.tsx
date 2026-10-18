import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { brandReport } from "@/lib/services/qrcatalog";
import { fmtTaipei } from "@/lib/services/class-orders";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "品牌報表", robots: { index: false, follow: false }, referrer: "no-referrer" };

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/** 品牌（廠商）唯讀報表：簽章連結、可撤銷、會到期；🔴 只有統計數字（掃描、轉換、銷量），沒有任何顧客資料 */
export default async function BrandReportPage(props: { params: Promise<{ site: string; token: string }> }) {
  const { site: raw, token } = await props.params;
  const site = await loadModulePage(raw, "qr-catalog");
  if (!site) notFound();
  const r = await brandReport(getStore(), site.tenant, decodeURIComponent(token));
  if (!r) notFound();
  const ctx = makeRenderCtx(site, "/brand-report");
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">{r.brand} 品牌報表</h1>
          <p className="gb-muted text-sm">最近 {r.sinceDays} 天 · 連結到期 {fmtTaipei(r.expiresAt)}{r.label ? ` · ${r.label}` : ""}</p>
          {r.products.map((p) => (
            <div key={p.name} className="gb-card mt-4 p-4 text-sm" data-gb="brand-product">
              <p className="m-0 text-base font-bold">{p.name}（{p.priceText}）</p>
              <p className="m-0 mt-1">掃描 {p.scans} 次 · 轉換 {p.conversions} · 售出 {p.soldQty} 件（{p.paidOrders} 張訂單，{twd(p.revenue)}）</p>
              {p.byCountryLang.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr><th className="p-1">國家</th><th className="p-1">語言</th><th className="p-1">掃描</th><th className="p-1">線上訂單</th><th className="p-1">海外詢價</th></tr>
                    </thead>
                    <tbody>
                      {p.byCountryLang.map((x, i) => (
                        <tr key={i}><td className="p-1">{x.country ?? "未知"}</td><td className="p-1">{x.lang}</td><td className="p-1">{x.scans}</td><td className="p-1">{x.orders}</td><td className="p-1">{x.inquiries}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          <p className="gb-muted mt-4 text-xs">國家依連線位置推測；轉換＝掃碼後 30 天內線上下單或海外寄送詢價。本報表不含任何顧客個人資料。</p>
        </div>
      </section>
    </SiteShell>
  );
}
