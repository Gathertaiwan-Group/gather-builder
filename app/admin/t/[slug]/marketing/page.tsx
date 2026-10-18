import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listCoupons } from "@/lib/services/coupons";
import { ServiceError } from "@/lib/services/context";
import { ReferralAdmin } from "./referral";

export const dynamic = "force-dynamic";

export default async function MarketingAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const cps = await listCoupons(ctx, { site: slug, limit: 100 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const act = `/api/admin/tenants/${slug}/coupons`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/marketing" name={tenant.name} />
      <Card title="折扣碼">
        {"error" in cps ? (
          <p className="m-0 text-sm text-neutral-600">{cps.error}</p>
        ) : (
          <>
            <table className="mb-4 w-full text-left text-sm" data-admin="coupon-table">
              <thead>
                <tr>
                  <th className="pr-3">代碼</th>
                  <th className="pr-3">折扣</th>
                  <th className="pr-3">條件</th>
                  <th className="pr-3">使用</th>
                  <th className="pr-3">期間</th>
                  <th className="pr-3">狀態</th>
                </tr>
              </thead>
              <tbody>
                {cps.coupons.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="py-1 pr-3">
                      {c.code}
                      {c.source === "referral" && <span className="ml-1 text-xs text-neutral-500">推薦回饋</span>}
                    </td>
                    <td className="py-1 pr-3">{c.kind === "fixed" ? `折 NT$${c.value}` : `${c.value}%（上限 NT$${c.maxDiscount}）`}</td>
                    <td className="py-1 pr-3">{c.minSubtotal ? `滿 NT$${c.minSubtotal}` : "-"}{c.perUserLimit ? ` · 每人 ${c.perUserLimit} 次` : ""}</td>
                    <td className="py-1 pr-3">
                      {c.usedCount}
                      {c.maxUses ? ` / ${c.maxUses}` : ""}
                    </td>
                    <td className="py-1 pr-3 text-xs">
                      {c.startsAt ? fmt(c.startsAt) : "即日"} ～ {c.endsAt ? fmt(c.endsAt) : "不限"}
                    </td>
                    <td className="py-1 pr-3">
                      <form action={act} method="post" className="flex items-center gap-1">
                        <input type="hidden" name="action" value="toggle" />
                        <input type="hidden" name="code" value={c.code} />
                        <input type="hidden" name="active" value={c.active ? "0" : "1"} />
                        {c.active ? "啟用中" : "已停用"}
                        <button className="rounded border px-2" type="submit">
                          {c.active ? "停用" : "啟用"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form action={act} method="post" className="grid grid-cols-1 gap-2 text-sm md:grid-cols-4">
              <input name="code" required placeholder="代碼（英數）" className="rounded border px-2 py-1" />
              <select name="kind" className="rounded border px-2 py-1" defaultValue="fixed">
                <option value="fixed">固定金額</option>
                <option value="percent">百分比</option>
              </select>
              <input name="value" required inputMode="numeric" placeholder="金額或百分比" className="rounded border px-2 py-1" />
              <input name="maxDiscount" inputMode="numeric" placeholder="百分比折抵上限（必填）" className="rounded border px-2 py-1" />
              <input name="minSubtotal" inputMode="numeric" placeholder="最低消費" className="rounded border px-2 py-1" />
              <input name="maxUses" inputMode="numeric" placeholder="總次數上限" className="rounded border px-2 py-1" />
              <input name="perUserLimit" inputMode="numeric" placeholder="每人次數上限" className="rounded border px-2 py-1" />
              <span />
              <label className="flex flex-col">
                開始（台北時間）
                <input name="startsAt" type="datetime-local" className="rounded border px-2 py-1" />
              </label>
              <label className="flex flex-col">
                結束
                <input name="endsAt" type="datetime-local" className="rounded border px-2 py-1" />
              </label>
              <div className="self-end">
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  建立折扣碼
                </button>
              </div>
            </form>
          </>
        )}
      </Card>
      <ReferralAdmin slug={slug} />
    </AdminShell>
  );
}
