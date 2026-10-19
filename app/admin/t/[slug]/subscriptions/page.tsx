import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listSubscriptionPlans, listSubscriptions } from "@/lib/services/subscriptions";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const LABEL: Record<string, string> = { pending: "處理中", active: "訂閱中", past_due: "扣款失敗（寬限）", cancelled: "已取消", expired: "已結束" };

export default async function SubscriptionsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const plans = await listSubscriptionPlans(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const subs = "error" in plans ? null : await listSubscriptions(ctx, { site: slug, limit: 100 });
  const act = `${bo.api}/subscriptions/action`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/subscriptions" name={tenant.name} />
      {"error" in plans ? (
        <Card title="訂閱">
          <p className="m-0 text-sm text-neutral-600">{plans.error}</p>
        </Card>
      ) : (
        <>
          <Card title="方案">
            <ul className="m-0 mb-4 flex list-none flex-col gap-2 p-0 text-sm" data-admin="sub-plans">
              {plans.plans.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2">
                  <strong>{p.name}</strong> {twd(p.amount)}/{p.interval === "month" ? "月" : "年"} · 試用 {p.trialDays} 天 · {p.totalPeriods} 期 · {p.entitlement.kind === "course" ? "開通課程" : "純月費"} · {p.status}
                  <form action={act} method="post" className="flex items-center gap-1">
                    <input type="hidden" name="action" value="plan_status" />
                    <input type="hidden" name="planId" value={p.id} />
                    <select name="status" defaultValue={p.status} className="rounded border px-1 text-xs">
                      <option value="draft">draft</option>
                      <option value="active">active（上架）</option>
                      <option value="archived">archived</option>
                    </select>
                    <label className="text-xs">
                      <input type="checkbox" name="confirm" required /> 確認
                    </label>
                    <button className="rounded border px-2 text-xs" type="submit">
                      更新
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            <form action={act} method="post" className="flex flex-col gap-2 text-sm">
              <input type="hidden" name="action" value="create_plan" />
              <p className="m-0 font-semibold">新增方案（藍新信用卡定期定額）</p>
              <input name="name" required placeholder="方案名稱" className="rounded border px-3 py-1" />
              <input name="amount" required type="number" min={30} placeholder="每期金額（NT$）" className="rounded border px-3 py-1" />
              <select name="interval" className="rounded border px-3 py-1">
                <option value="month">每月</option>
                <option value="year">每年</option>
              </select>
              <input name="trialDays" type="number" min={0} max={28} placeholder="試用天數（0–28，預設 0）" className="rounded border px-3 py-1" />
              <input name="totalPeriods" type="number" min={1} max={99} placeholder="期數上限（預設 99）" className="rounded border px-3 py-1" />
              <input name="courseId" placeholder="開通課程 id（選填；空白＝純月費）" className="rounded border px-3 py-1" />
              <textarea name="description" placeholder="說明（選填）" className="rounded border px-3 py-1" />
              <label className="flex items-center gap-1">
                <input type="checkbox" name="activate" /> 立即上架
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" name="confirm" /> 確認（上架時必勾）
              </label>
              <div>
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  建立
                </button>
              </div>
            </form>
          </Card>
          <Card title={`訂閱（${subs?.total ?? 0}）`}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-admin="sub-list">
                <thead>
                  <tr>
                    <th className="py-1 pr-3">會員</th>
                    <th className="py-1 pr-3">方案</th>
                    <th className="py-1 pr-3">狀態</th>
                    <th className="py-1 pr-3">期間到</th>
                    <th className="py-1 pr-3">取消</th>
                    <th className="py-1 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  {subs?.subscriptions.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="py-1 pr-3">{s.member.email}</td>
                      <td className="py-1 pr-3">
                        {s.plan.name} {twd(s.amount)}
                        {s.sandbox && " ［測試］"}
                      </td>
                      <td className="py-1 pr-3">{LABEL[s.status] ?? s.status}</td>
                      <td className="py-1 pr-3">{s.status === "past_due" ? `寬限到 ${s.graceUntil ? fmt(s.graceUntil) : "-"}` : s.currentPeriodEnd ? fmt(s.currentPeriodEnd) : "-"}</td>
                      <td className="py-1 pr-3">{s.cancelState === "failed" ? `終止失敗：${s.cancelError ?? ""}` : s.cancelState}</td>
                      <td className="py-1 pr-3">
                        {(s.status === "active" || s.status === "past_due" || s.status === "pending") && (
                          <form action={act} method="post" className="flex items-center gap-1">
                            <input type="hidden" name="action" value="cancel" />
                            <input type="hidden" name="subscriptionId" value={s.id} />
                            <label className="text-xs">
                              <input type="checkbox" name="confirm" required /> 確認
                            </label>
                            <button className="rounded border px-2 text-xs" type="submit">
                              取消訂閱
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
