import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listDomains } from "@/lib/services/domains";
import { getDomainAdapter } from "@/lib/domains/adapter";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { pending: "等待 DNS／驗證", verified: "已驗證（尚未啟用）", active: "啟用中（正式網址）" };

export default async function DomainsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listDomains(ctx, { site: slug });
  const adapter = getDomainAdapter();
  const act = `/api/admin/tenants/${slug}/domains`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/domains" name={tenant.name} />
      <Card title="網址">
        <p className="mt-0 text-sm">
          目前正式網址：<a href={r.siteUrl} data-admin="site-url">{r.siteUrl}</a>
        </p>
        <p className="text-sm text-neutral-600">
          {r.subdomainEnabled ? "子網域已啟用。" : "平台尚未啟用子網域（PLATFORM_SITES_DOMAIN 未設定），目前使用 /s/<代號> 網址。"}
          {adapter ? `網域 API：${adapter.name}` : "平台尚未設定網域 API（VERCEL_DOMAINS_TOKEN），暫時無法新增自有網域。"}
        </p>
      </Card>
      <Card title={`自有網域（${r.domains.length}）`}>
        <ul className="m-0 flex flex-col gap-4 p-0 text-sm" data-admin="domains">
          {r.domains.map((d) => (
            <li key={d.id} className="list-none border-b pb-3" data-admin="domain-row" data-status={d.status}>
              <b>{d.domain}</b> · {STATUS[d.status] ?? d.status}
              {d.lastError && <span className="text-red-700"> · {d.lastError}</span>}
              {d.status !== "active" && d.dnsRecords.length > 0 && (
                <table className="mt-2 text-left text-xs">
                  <thead>
                    <tr>
                      <th className="pr-3">類型</th>
                      <th className="pr-3">名稱</th>
                      <th className="pr-3">值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.dnsRecords.map((x, i) => (
                      <tr key={i}>
                        <td className="pr-3">{x.type}</td>
                        <td className="pr-3">{x.name}</td>
                        <td className="break-all pr-3">{x.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <form action={act} method="post">
                  <input type="hidden" name="action" value="check" />
                  <input type="hidden" name="domainId" value={d.id} />
                  <button className="rounded border px-2 py-0.5 text-xs" type="submit">重新檢查</button>
                </form>
                {d.status === "verified" && (
                  <form action={act} method="post" className="flex items-center gap-1">
                    <input type="hidden" name="action" value="activate" />
                    <input type="hidden" name="domainId" value={d.id} />
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="confirm" required /> 確認
                    </label>
                    <button className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white" type="submit">啟用為正式網址</button>
                  </form>
                )}
                <form action={act} method="post" className="flex items-center gap-1">
                  <input type="hidden" name="action" value="remove" />
                  <input type="hidden" name="domainId" value={d.id} />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" name="confirm" required /> 確認
                  </label>
                  <button className="rounded border px-2 py-0.5 text-xs" type="submit">移除</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
        <form action={act} method="post" className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="action" value="add" />
          <input name="domain" required placeholder="shop.example.com" className="rounded border px-3 py-1" />
          <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">新增網域</button>
        </form>
      </Card>
    </AdminShell>
  );
}
