import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listMembers } from "@/lib/services/members";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function MembersAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; q?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const r = await listMembers(ctx, { site: slug, limit: 100, q: sp.q }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/members" name={tenant.name} />
      <Card title={"error" in r ? "會員" : `會員（${r.total}）`}>
        {"error" in r ? (
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        ) : (
          <>
            <form method="get" className="mb-4 flex gap-2 text-sm">
              <input name="q" defaultValue={sp.q ?? ""} placeholder="搜尋 Email" className="rounded border px-3 py-1" />
              <button className="rounded border px-3 py-1" type="submit">
                搜尋
              </button>
            </form>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th className="py-1 pr-3">Email</th>
                    <th className="py-1 pr-3">姓名</th>
                    <th className="py-1 pr-3">狀態</th>
                    <th className="py-1 pr-3">註冊</th>
                    <th className="py-1 pr-3">最後登入</th>
                    <th className="py-1 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {r.members.map((m) => (
                    <tr key={m.id} className="border-t" data-admin="member-row">
                      <td className="py-1 pr-3 break-all">
                        {m.email}
                        {m.emailVerified ? " ✓" : ""}
                      </td>
                      <td className="py-1 pr-3">{m.name ?? ""}</td>
                      <td className="py-1 pr-3">{m.status === "active" ? "正常" : "已停用"}</td>
                      <td className="py-1 pr-3">{fmt(m.createdAt)}</td>
                      <td className="py-1 pr-3">{fmt(m.lastLoginAt)}</td>
                      <td className="py-1 pr-3">
                        <form action={`${bo.api}/members/status`} method="post" className="flex items-center gap-1">
                          <input type="hidden" name="memberId" value={m.id} />
                          <input type="hidden" name="status" value={m.status === "active" ? "disabled" : "active"} />
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" name="confirm" required />
                            確認
                          </label>
                          <button type="submit" className="underline">
                            {m.status === "active" ? "停用" : "啟用"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </AdminShell>
  );
}
