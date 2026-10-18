import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { getMemberPoints, listTiers } from "@/lib/services/loyalty";
import { getMemberBalance, listTopupPlans } from "@/lib/services/wallet";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const orErr = <T,>(p: Promise<T>) => p.catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));

/** 會員經營：點數／等級／儲值金。查某位會員、手動調整（confirm＋理由），儲值方案列表 */
export default async function LoyaltyAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; email?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const tiers = await orErr(listTiers(ctx, { site: slug }));
  const plans = await orErr(listTopupPlans(ctx, { site: slug }));
  const email = sp.email?.trim();
  const pts = email && !("error" in tiers) ? await orErr(getMemberPoints(ctx, { site: slug, email })) : null;
  const bal = email && !("error" in plans) ? await orErr(getMemberBalance(ctx, { site: slug, email })) : null;
  const act = `/api/admin/tenants/${slug}/loyalty/action`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/loyalty" name={tenant.name} />
      <Card title="查詢會員">
        <form method="get" className="flex flex-wrap gap-2 text-sm">
          <input name="email" type="email" defaultValue={email} placeholder="會員 Email" className="rounded border px-3 py-1" required />
          <button className="rounded border px-3 py-1" type="submit">查詢</button>
        </form>
        {pts && ("error" in pts ? <p className="text-sm text-red-700">{pts.error}</p> : (
          <div className="mt-3 text-sm" data-admin="member-points">
            點數：可用 {pts.available}／帳本餘額 {pts.balance} · 等級 {pts.tier?.name ?? "一般"}（期間消費 NT${pts.spendInWindow}）
            <ul className="m-0 mt-1 text-xs text-neutral-600">
              {pts.ledger.slice(0, 10).map((l, i) => (
                <li key={i}>{l.at.slice(0, 16)} {l.kind} {l.amount > 0 ? `+${l.amount}` : l.amount} {l.reason ?? ""}{l.shortfall ? `（不足 ${l.shortfall}）` : ""}</li>
              ))}
            </ul>
          </div>
        ))}
        {bal && ("error" in bal ? <p className="text-sm text-red-700">{bal.error}</p> : (
          <div className="mt-3 text-sm" data-admin="member-wallet">
            儲值金：可用 NT${bal.available}／帳本餘額 NT${bal.balance}
            <ul className="m-0 mt-1 text-xs text-neutral-600">
              {bal.ledger.slice(0, 10).map((l, i) => (
                <li key={i}>{l.at.slice(0, 16)} {l.kind} {l.amount > 0 ? `+${l.amount}` : l.amount} {l.reason ?? ""}{l.shortfall ? `（不足 ${l.shortfall}）` : ""}</li>
              ))}
            </ul>
          </div>
        ))}
      </Card>
      <Card title="手動調整（只增不改帳本）">
        <form action={act} method="post" className="flex flex-wrap items-center gap-2 text-sm">
          <select name="ledger" className="rounded border px-2 py-1">
            {!("error" in tiers) && <option value="points">點數</option>}
            {!("error" in plans) && <option value="wallet">儲值金（NT$）</option>}
          </select>
          <input name="email" type="email" defaultValue={email} placeholder="會員 Email" className="rounded border px-3 py-1" required />
          <input name="amount" type="number" placeholder="正＝加、負＝扣" className="w-32 rounded border px-3 py-1" required />
          <input name="reason" placeholder="理由（必填）" className="rounded border px-3 py-1" required minLength={2} />
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" name="confirm" required /> 確認
          </label>
          <button className="rounded border px-3 py-1" type="submit">送出</button>
        </form>
      </Card>
      <Card title="會員等級">
        {"error" in tiers ? <p className="m-0 text-sm text-neutral-600">{tiers.error}</p> : (
          <ul className="m-0 text-sm">
            {tiers.published.length === 0 && <li className="text-neutral-500">尚未設定等級（用 MCP update_tiers）</li>}
            {tiers.published.map((t) => (
              <li key={t.id}>{t.name}（{t.id}）· 門檻 NT${t.minSpend} · 倍率 {t.multiplier} · 折扣 {t.discountPercent}% · {tiers.memberCounts[t.id] ?? 0} 人</li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="儲值方案">
        {"error" in plans ? <p className="m-0 text-sm text-neutral-600">{plans.error}</p> : (
          <>
            <ul className="m-0 text-sm">
              {plans.plans.map((p) => (
                <li key={p.id} data-admin="topup-plan">{p.name} · 付 NT${p.payAmount} 得 NT${p.creditTotal}{p.bonusExpireDays ? `（贈送 ${p.bonusExpireDays} 天到期）` : ""} · {p.status}</li>
              ))}
            </ul>
            <p className="mb-0 mt-2 text-xs text-amber-700">🔴 儲值金屬預收款：正式上線前請店家確認是否需依《零售業等禮券定型化契約應記載及不得記載事項》提供履約保證或信託，平台只提供功能。</p>
          </>
        )}
      </Card>
    </AdminShell>
  );
}
