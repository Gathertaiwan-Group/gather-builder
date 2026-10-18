import type { MemberRow, TenantRow } from "@/lib/store/types";
import { getStore } from "@/lib/store";
import { memberPointsView } from "@/lib/services/loyalty";
import { fmtTaipei } from "@/lib/services/class-orders";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const KIND: Record<string, string> = { earn: "消費賺點", redeem: "折抵", expire: "到期", reverse: "沖回／退回", adjust: "店家調整", topup: "儲值", spend: "消費", refund: "退回" };

/** 會員中心：點數（餘額、到期明細、等級）。儲值金由 stored-value 模組另外顯示 */
export async function MemberPoints({ tenant, member }: { tenant: TenantRow; member: MemberRow }) {
  const v = await memberPointsView(getStore(), tenant, member);
  return (
    <div className="gb-card mb-6 p-5 text-sm" data-gb="my-points">
      <h2 className="m-0 mb-2 text-lg font-bold">我的點數</h2>
      <p className="m-0">
        可用點數：<strong data-gb="points-available">{v.available}</strong> 點
        {v.balance !== v.available && <span className="gb-muted">（含待到期處理共 {v.balance} 點）</span>}
      </p>
      <p className="m-0 mt-1">
        會員等級：<strong data-gb="member-tier">{v.tier?.name ?? "一般會員"}</strong>
        <span className="gb-muted">（{v.windowMonths ? `近 ${v.windowMonths} 個月` : "累計"}消費 {twd(v.spend)}{v.nextTier ? `，再消費 ${twd(v.nextTier.need)} 升級「${v.nextTier.name}」` : ""}）</span>
      </p>
      {v.expiring.length > 0 && (
        <div className="mt-3" data-gb="points-expiring">
          <h3 className="m-0 mb-1 text-sm font-bold">即將到期</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {v.expiring.map((e, i) => (
              <li key={i}>
                {e.points} 點 · {fmtTaipei(e.expiresAt, false)} 到期
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.recent.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer">點數紀錄</summary>
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {v.recent.map((e, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2">
                <span>
                  {KIND[e.kind] ?? e.kind}
                  {e.reason ? `（${e.reason}）` : ""}
                </span>
                <span>
                  {e.amount > 0 ? `+${e.amount}` : e.amount} · {fmtTaipei(e.at, false)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
