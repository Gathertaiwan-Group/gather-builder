import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getPlatformOrderStatus } from "@/lib/services/platform-billing";
import { platformDeps } from "@/lib/platform/routes";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";
// 網址帶存取金鑰：不送 referrer、不索引
export const metadata = { title: "訂單狀態｜Gather Builder", referrer: "no-referrer" as const, robots: { index: false, follow: false } };

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const KIND = { new_site: "開站", add_modules: "加購模組", renewal: "月費續約" } as const;
const STATUS = { pending_payment: "待付款", paid: "已付款", expired: "已逾期", cancelled: "已取消", paid_needs_attention: "已付款（需人工處理）" } as const;

export default async function OrderPage({ params, searchParams }: { params: Promise<{ orderNo: string }>; searchParams: Promise<{ k?: string; err?: string }> }) {
  const [{ orderNo }, sp] = await Promise.all([params, searchParams]);
  const deps = platformDeps(new Request("http://internal/", { headers: new Headers(await headers()) }));
  const o = await getPlatformOrderStatus(deps, { orderNo: decodeURIComponent(orderNo), accessKey: sp.k }).catch((e) => (e instanceof ServiceError ? null : Promise.reject(e)));
  if (!o) notFound();
  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mt-0 text-xl font-bold">
        {KIND[o.kind]}訂單 {o.orderNo}
      </h1>
      {o.paymentsOpen && o.status === "pending_payment" && <meta httpEquiv="refresh" content="10" />}
      {sp.err && (
        <p role="alert" className="rounded bg-red-50 px-4 py-3 text-sm text-red-900">
          {sp.err}
        </p>
      )}
      <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm" data-build="order">
        <dt>狀態</dt>
        <dd data-build="status">
          {STATUS[o.status]}
          {o.sandbox && "（測試環境）"}
        </dd>
        {o.brandName && (
          <>
            <dt>網站</dt>
            <dd>
              {o.brandName}
              {o.slug && `（${o.slug}）`}
            </dd>
          </>
        )}
        <dt>模組</dt>
        <dd>{o.modules.join("、") || "—"}</dd>
        <dt>建置費</dt>
        <dd>{twd(o.amountSetup)}</dd>
        <dt>月費</dt>
        <dd>{twd(o.amountMonthly)}</dd>
        <dt>這次付款</dt>
        <dd>
          <b data-build="total">{twd(o.amountTotal)}</b>
        </dd>
      </dl>
      {o.status === "pending_payment" &&
        (o.paymentsOpen ? (
          <form action="/api/build/pay" method="post" className="mt-6">
            <input type="hidden" name="orderNo" value={o.orderNo} />
            <input type="hidden" name="k" value={sp.k ?? ""} />
            <button className="rounded bg-neutral-900 px-4 py-2 text-white" type="submit" data-build="pay">
              前往付款
            </button>
            <p className="text-xs text-neutral-500">付款請在 {new Date(o.expiresAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })} 前完成。付款完成後這頁會自動更新。</p>
          </form>
        ) : (
          <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">尚未開放付款。</p>
        ))}
      {o.status === "paid" && (
        <div className="mt-6 rounded border p-4 text-sm" data-build="provision" data-state={o.provisionState}>
          {o.provisionState === "done" ? (
            <>
              <p className="mt-0 font-semibold">網站已準備好！</p>
              {o.siteUrl && (
                <p>
                  網站：<a href={o.siteUrl}>{o.siteUrl}</a>
                </p>
              )}
              {o.ownerUrl && (
                <p className="mb-0">
                  店主後台：<a href={o.ownerUrl}>{o.ownerUrl}</a>（設定密碼的邀請信已寄到你的 Email）
                </p>
              )}
            </>
          ) : o.provisionState === "failed" ? (
            <p className="m-0">付款已確認，開站時發生問題，系統會自動重試，我們也已收到通知。</p>
          ) : (
            <p className="m-0">付款已確認，網站建立中…（重新整理查看）</p>
          )}
        </div>
      )}
    </main>
  );
}
