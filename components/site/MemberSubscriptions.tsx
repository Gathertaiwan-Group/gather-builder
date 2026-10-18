import { getStore } from "@/lib/store";
import { memberSubscriptions } from "@/lib/services/subscriptions";
import type { MemberRow, TenantRow } from "@/lib/store/types";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const LABEL: Record<string, string> = { pending: "處理中", active: "訂閱中", past_due: "扣款失敗（寬限中）", cancelled: "已取消", expired: "已結束" };
const date = (s: string | null) => (s ? new Date(new Date(s).getTime() + 8 * 3600_000).toISOString().slice(0, 10) : "-");

/** 會員中心「我的訂閱」：狀態、權益到期、取消（POST，同源表單） */
export async function MemberSubscriptions({ tenant, member }: { tenant: TenantRow; member: MemberRow }) {
  const subs = await memberSubscriptions(getStore(), tenant, member);
  return (
    <div className="gb-card mb-6 p-5" data-gb="my-subscriptions">
      <h2 className="m-0 mb-3 text-lg font-bold">我的訂閱</h2>
      {!subs.length ? (
        <p className="gb-muted m-0 text-sm">還沒有訂閱。</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm">
          {subs.map((s) => (
            <li key={s.id} className="flex flex-col gap-1">
              <span>
                <strong>{s.plan.name ?? "方案"}</strong> · {twd(s.amount)} / {s.interval === "month" ? "月" : "年"} · {LABEL[s.status] ?? s.status}
                {s.sandbox && <span className="gb-muted">［測試環境］</span>}
              </span>
              <span className="gb-muted text-xs">
                {s.status === "past_due" ? `請於 ${date(s.graceUntil)} 前確認信用卡可扣款` : s.status === "cancelled" ? `權益保留到 ${date(s.endedAt)}` : `目前期間到 ${date(s.currentPeriodEnd)}`}
                {s.cancelState === "failed" && " · 取消處理中（系統會自動重試）"}
              </span>
              {(s.status === "active" || s.status === "past_due") && (
                <form method="post" action={`/s/${tenant.slug}/api/subscriptions/cancel`} className="flex items-center gap-2">
                  <input type="hidden" name="subscriptionId" value={s.id} />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" required /> 我確定要取消（之後不再扣款）
                  </label>
                  <button className="gb-btn" type="submit" style={{ background: "transparent", color: "var(--gb-primary)", border: "1px solid var(--gb-primary)" }}>
                    取消訂閱
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
