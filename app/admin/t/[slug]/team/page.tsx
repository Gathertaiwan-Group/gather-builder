import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listTeam } from "@/lib/services/owners";

export const dynamic = "force-dynamic";

const ROLE = { owner: "擁有者", editor: "編輯", viewer: "檢視者" } as const;
const STATUS = { invited: "已邀請", active: "啟用", disabled: "停用" } as const;

/** 成員（邀請制、角色、停用）：只有 owner 角色或平台後台能修改 */
export default async function TeamPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const r = await listTeam(bo.ctx, { site: slug });
  const canEdit = bo.role === "owner" || bo.role === "admin";
  const act = `${bo.api}/team`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/team" name={bo.tenant.name} />
      <Card title={`成員（${r.members.length}）`}>
        <table className="w-full text-left text-sm" data-admin="team">
          <thead>
            <tr>
              <th className="pr-3">Email</th>
              <th className="pr-3">角色</th>
              <th className="pr-3">狀態</th>
              <th className="pr-3">二步驟</th>
              <th className="pr-3">最後登入</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.members.map((m) => (
              <tr key={m.id} className="border-t" data-admin="team-row">
                <td className="py-1 pr-3">{m.email}</td>
                <td className="pr-3">{ROLE[m.role]}</td>
                <td className="pr-3">{STATUS[m.status]}</td>
                <td className="pr-3">{m.totp ? "已啟用" : "—"}</td>
                <td className="pr-3">{fmt(m.lastLoginAt)}</td>
                <td>
                  {canEdit && (
                    <form action={act} method="post" className="flex flex-wrap items-center gap-1 text-xs">
                      <input type="hidden" name="action" value="update" />
                      <input type="hidden" name="membershipId" value={m.id} />
                      <select name="role" defaultValue={m.role} className="rounded border px-1">
                        <option value="owner">擁有者</option>
                        <option value="editor">編輯</option>
                        <option value="viewer">檢視者</option>
                      </select>
                      <select name="status" defaultValue={m.status === "invited" ? "" : m.status} className="rounded border px-1">
                        {m.status === "invited" && <option value="">（已邀請）</option>}
                        <option value="active">啟用</option>
                        <option value="disabled">停用</option>
                      </select>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" name="confirm" /> 確認
                      </label>
                      <button className="rounded border px-2" type="submit">更新</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canEdit && (
        <Card title="邀請成員">
          <form action={act} method="post" className="flex flex-wrap items-center gap-2 text-sm">
            <input type="hidden" name="action" value="invite" />
            <input name="email" type="email" required placeholder="email" className="rounded border px-3 py-1" />
            <select name="role" className="rounded border px-2 py-1">
              <option value="editor">編輯（可改內容與訂單，不能改金流與成員）</option>
              <option value="viewer">檢視者（只讀）</option>
              <option value="owner">擁有者（全部）</option>
            </select>
            <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">寄出邀請</button>
          </form>
        </Card>
      )}
    </AdminShell>
  );
}
