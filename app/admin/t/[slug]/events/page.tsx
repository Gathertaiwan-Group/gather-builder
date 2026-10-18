import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listEvents, listRegistrations, revealRegistration } from "@/lib/services/events";
import { fmtTaipei } from "@/lib/services/class-orders";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { held: "待付款", confirmed: "已確認", cancelled: "已取消", expired: "逾期" };
const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

export default async function EventsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; session?: string; reveal?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listEvents(ctx, { site: slug, limit: 50 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const roster = sp.session && !("error" in r) ? await listRegistrations(ctx, { site: slug, sessionId: sp.session }).catch(() => null) : null;
  // 🔴 查看完整個資：每次都寫查看紀錄（who/when）
  const revealed = sp.reveal ? await revealRegistration(ctx, { site: slug, registrationId: sp.reveal, reason: "後台查看" }).catch(() => null) : null;
  const pii = await ctx.store.listPiiLog(tenant.id, 20);
  const act = `/api/admin/tenants/${slug}/events/action`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/events" name={tenant.name} />
      <Card title="簽到">
        <form action={act} method="post" className="flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="action" value="checkin" />
          {sp.session && <input type="hidden" name="sessionId" value={sp.session} />}
          <input name="code" placeholder="簽到碼（10 碼）" className="rounded border px-3 py-1" autoComplete="off" required />
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" name="confirm" required />
            確認
          </label>
          <button className="rounded border px-3 py-1" type="submit">
            簽到
          </button>
        </form>
      </Card>
      <Card title={"error" in r ? "活動" : `活動（${r.total}）`}>
        {"error" in r ? (
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        ) : r.events.length === 0 ? (
          <p className="m-0 text-sm text-neutral-600">還沒有活動（用 MCP create_event 建立）。</p>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {r.events.map((e) => (
              <div key={e.id} data-admin="event">
                <p className="m-0 font-semibold">
                  {e.title} <span className="font-normal text-neutral-500">/{e.slug} · {e.status}</span>
                </p>
                <ul className="m-0 mt-1 list-none p-0">
                  {e.sessions.map((s) => (
                    <li key={s.id} className="flex flex-wrap gap-3 border-t py-1">
                      <a href={`/admin/t/${slug}/events?session=${s.id}`}>{s.startsAtTaipei}</a>
                      <span>
                        容量 {s.capacity}・已報名 {s.registered}・保留 {s.offered}・剩 {s.remaining}・候補 {s.waiting}
                        {s.status === "cancelled" ? "・已取消" : ""}
                      </span>
                      <span className="text-neutral-500">{s.tickets.map((t) => `${t.name} ${t.price ? twd(t.price) : "免費"}`).join("、")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
      {roster && sp.session && (
        <Card title={`名單（${roster.total}）・已確認 ${roster.confirmedSeats} 位・待付款 ${roster.heldSeats} 位・已簽到 ${roster.checkedIn}`}>
          <p className="mt-0 text-xs text-neutral-600">
            聯絡資料已遮罩；「查看」與「匯出 CSV」都會留下查看紀錄。 <a href={`/api/admin/tenants/${slug}/events/roster?session=${sp.session}`} data-admin="roster-csv">匯出 CSV</a>
          </p>
          {revealed && (
            <p className="rounded bg-amber-50 p-2 text-sm" data-admin="revealed">
              {revealed.contact.name}・{revealed.contact.email}・{revealed.contact.phone}
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="py-1 pr-3">姓名</th>
                  <th className="py-1 pr-3">Email</th>
                  <th className="py-1 pr-3">票種</th>
                  <th className="py-1 pr-3">狀態</th>
                  <th className="py-1 pr-3">簽到</th>
                  <th className="py-1 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {roster.registrations.map((g) => (
                  <tr key={g.id} className="border-t" data-admin="registration-row">
                    <td className="py-1 pr-3">{g.contact.name}</td>
                    <td className="py-1 pr-3">{g.contact.email}</td>
                    <td className="py-1 pr-3">
                      {g.ticket} × {g.qty}
                    </td>
                    <td className="py-1 pr-3">
                      {STATUS[g.status] ?? g.status}
                      {g.refundRequired ? "・待退款" : ""}
                    </td>
                    <td className="py-1 pr-3">{g.checkedInAt ? fmt(g.checkedInAt) : ""}</td>
                    <td className="flex flex-wrap gap-2 py-1 pr-3">
                      <form method="get">
                        <input type="hidden" name="session" value={sp.session} />
                        <input type="hidden" name="reveal" value={g.id} />
                        <button className="rounded border px-2" type="submit">
                          查看
                        </button>
                      </form>
                      {g.status === "confirmed" && !g.checkedInAt && (
                        <form action={act} method="post" className="flex items-center gap-1">
                          <input type="hidden" name="action" value="checkin" />
                          <input type="hidden" name="sessionId" value={sp.session} />
                          <input type="hidden" name="registrationId" value={g.id} />
                          <input type="checkbox" name="confirm" required aria-label="確認簽到" />
                          <button className="rounded border px-2" type="submit">
                            簽到
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form action={act} method="post" className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <input type="hidden" name="action" value="cancel_session" />
            <input type="hidden" name="sessionId" value={sp.session} />
            <input name="reason" placeholder="取消原因（會寄給報名者）" className="rounded border px-3 py-1" />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="confirm" required />
              確認取消（無法復原；已付款者需人工退款）
            </label>
            <button className="rounded border border-red-300 px-3 py-1 text-red-700" type="submit">
              取消這個場次
            </button>
          </form>
        </Card>
      )}
      <Card title="個資查看紀錄（最近 20 筆）">
        <ul className="m-0 list-none p-0 text-xs text-neutral-600">
          {pii.map((p) => (
            <li key={p.id}>
              {fmtTaipei(p.at)}・{p.actor}・{p.action === "reveal" ? "查看" : "匯出"} {p.subject_type}
            </li>
          ))}
        </ul>
      </Card>
    </AdminShell>
  );
}
