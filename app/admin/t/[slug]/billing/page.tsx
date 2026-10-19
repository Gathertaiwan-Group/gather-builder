import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { billingSummary } from "@/lib/services/platform-billing";
import { buildCatalog } from "@/lib/platform/pricing";

export const dynamic = "force-dynamic";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const STATUS = { active: "使用中", past_due: "逾期（寬限期）", suspended: "已停站", cancelled: "已停止續費" } as const;
const OSTATUS = { pending_payment: "待付款", paid: "已付款", expired: "已逾期", cancelled: "已取消", paid_needs_attention: "已付款（需人工處理）" } as const;

/** 方案與加購：平台月費狀態、加購模組（付款後自動開通）、停止／恢復續費、待付款單付款 */
export default async function BillingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const r = await billingSummary(bo.ctx, { site: slug });
  const owned = new Set([...(r.billing?.modules ?? []), ...r.enabledModules]);
  const canEdit = bo.role === "owner" || bo.role === "admin";
  const act = `${bo.api}/billing`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/billing" name={bo.tenant.name} />
      {!r.billing ? (
        <Card title="方案">
          <p className="m-0 text-sm">這個網站不是經 /build 開立的，沒有平台月費。加購請聯絡平台。</p>
        </Card>
      ) : (
        <>
          <Card title="方案">
            <p className="mt-0 text-sm" data-admin="billing">
              狀態：{STATUS[r.billing.status]} · 月費 {twd(r.billing.monthly_amount)} · 已付到 {fmt(r.billing.paid_until)}
              {r.billing.cancel_at_period_end && "（到期後停止）"}
              {r.billing.is_test && "（測試網站）"}
            </p>
            {canEdit && (
              <form action={act} method="post" className="flex items-center gap-2 text-sm">
                <input type="hidden" name="action" value={r.billing.cancel_at_period_end ? "resume" : "cancel"} />
                {!r.billing.cancel_at_period_end && (
                  <label className="flex items-center gap-1">
                    <input type="checkbox" name="confirm" required /> 確認
                  </label>
                )}
                <button className="rounded border px-3 py-1" type="submit">
                  {r.billing.cancel_at_period_end ? "恢復續費" : "停止續費（到期後停站，資料保留）"}
                </button>
              </form>
            )}
          </Card>
          {canEdit && r.paymentsOpen && (r.billing.status !== "active" || r.billing.cancel_at_period_end) && (
            <Card title="付月費">
              <form action={act} method="post" className="text-sm">
                <input type="hidden" name="action" value="renew" />
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit" data-admin="renew">
                  {r.billing.status === "suspended" ? "付月費並恢復網站" : "付下一期月費"}
                </button>
              </form>
            </Card>
          )}
          {canEdit && (
            <Card title="加購模組">
              {r.paymentsOpen ? (
                <form action={act} method="post" className="flex flex-col gap-2 text-sm">
                  <input type="hidden" name="action" value="addon" />
                  <div className="grid gap-2 sm:grid-cols-2">
                    {buildCatalog()
                      .filter((m) => !m.base && !owned.has(m.id))
                      .map((m) => (
                        <label key={m.id} className="flex gap-2 rounded border p-2" data-admin="addon-module">
                          <input type="checkbox" name="modules" value={m.id} />
                          <span>
                            <b>{m.name}</b>
                            <span className="block text-xs text-neutral-500">
                              建置 {twd(m.priceSetup)} · 月費 {twd(m.priceMonthly)}
                              {m.requires.length > 0 && ` · 需要 ${m.requires.join("、")}（自動帶入）`}
                            </span>
                          </span>
                        </label>
                      ))}
                  </div>
                  <div>
                    <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">試算並前往付款</button>
                  </div>
                </form>
              ) : (
                <p className="m-0 text-sm">尚未開放付款。</p>
              )}
            </Card>
          )}
        </>
      )}
      <Card title={`平台訂單（${r.orders.length}）`}>
        <ul className="m-0 flex flex-col gap-2 p-0 text-sm" data-admin="platform-orders">
          {r.orders.map((o) => (
            <li key={o.orderNo} className="list-none border-b pb-2">
              {o.orderNo} · {o.kind} · {twd(o.amountTotal)} · {OSTATUS[o.status]}
              {o.sandbox && "（測試）"} · 開通 {o.provisionState}
              {o.status === "pending_payment" && canEdit && (
                <form action={act} method="post" className="ml-2 inline">
                  <input type="hidden" name="action" value="pay" />
                  <input type="hidden" name="orderNo" value={o.orderNo} />
                  <button className="rounded border px-2 text-xs" type="submit">前往付款</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </AdminShell>
  );
}
