import { Card, fmt } from "@/components/admin/AdminShell";
import type { Backoffice } from "@/lib/backoffice";
import { listReferrals } from "@/lib/services/referral";
import { ServiceError } from "@/lib/services/context";

/** 推薦分潤報表（referral 模組啟用後才有內容） */
export async function ReferralAdmin({ bo }: { bo: Backoffice }) {
  const r = await listReferrals(bo.ctx, { site: bo.slug }).catch((e) => (e instanceof ServiceError ? null : Promise.reject(e)));
  if (!r) return null;
  return (
    <Card title={`推薦回饋（成功推薦 ${r.totalReferrals} 人）`}>
      <table className="mb-4 w-full text-left text-sm" data-admin="referral-table">
        <thead>
          <tr>
            <th className="pr-3">推薦人</th>
            <th className="pr-3">推薦碼</th>
            <th className="pr-3">KOL 分潤</th>
            <th className="pr-3">成功推薦</th>
            <th className="pr-3">分潤（已扣沖回）</th>
          </tr>
        </thead>
        <tbody>
          {r.referrers.map((x) => (
            <tr key={x.memberId} className="border-t">
              <td className="py-1 pr-3">{x.email}</td>
              <td className="py-1 pr-3">{x.code}</td>
              <td className="py-1 pr-3">{x.kolRatePercent}%</td>
              <td className="py-1 pr-3">{x.referrals}</td>
              <td className="py-1 pr-3">
                NT${x.commission}
                {x.reversed !== 0 && <span className="text-xs text-neutral-500">（沖回 {x.reversed}）</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={`${bo.api}/referral-kol`} method="post" className="flex flex-wrap items-center gap-2 text-sm">
        <input name="email" required placeholder="會員 Email" className="rounded border px-2 py-1" />
        <input name="rate" required inputMode="decimal" placeholder="分潤 %（0–50）" className="w-32 rounded border px-2 py-1" />
        <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
          設定 KOL 分潤
        </button>
      </form>
      {r.recentLedger.length > 0 && (
        <ul className="mt-3 text-xs text-neutral-600">
          {r.recentLedger.slice(0, 10).map((l, i) => (
            <li key={i}>
              {fmt(l.at)} {l.kind === "earn" ? "分潤" : "沖回"} NT${l.amount}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
