import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listBroadcasts, listSubscribers } from "@/lib/services/newsletter";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function NewsletterAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const subs = await listSubscribers(ctx, { site: slug, limit: 100 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const bc = "error" in subs ? null : await listBroadcasts(ctx, { site: slug });
  const act = `${bo.api}/newsletter`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/newsletter" name={tenant.name} />
      {"error" in subs ? (
        <Card title="電子報">
          <p className="m-0 text-sm text-neutral-600">{subs.error}</p>
        </Card>
      ) : (
        <>
          {!process.env.RESEND_API_KEY && <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">⚠️ 尚未設定 RESEND_API_KEY：確認信與電子報都寄不出去。</p>}
          <Card title={`訂閱者（已確認 ${subs.counts.confirmed}・待確認 ${subs.counts.pending}・已退訂 ${subs.counts.unsubscribed}）`}>
            <ul className="m-0 max-h-64 overflow-auto text-sm" data-admin="subscribers">
              {subs.subscribers.map((s) => (
                <li key={s.id}>
                  {s.email} · {s.status === "confirmed" ? "已確認" : s.status === "pending" ? "待確認" : "已退訂"} · {fmt(s.createdAt)}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="群發">
            <table className="mb-4 w-full text-left text-sm" data-admin="broadcasts">
              <thead>
                <tr>
                  <th className="pr-3">主旨</th>
                  <th className="pr-3">狀態</th>
                  <th className="pr-3">寄送統計</th>
                  <th className="pr-3">動作</th>
                </tr>
              </thead>
              <tbody>
                {bc?.broadcasts.map((b) => (
                  <tr key={b.id} className="border-t align-top">
                    <td className="py-1 pr-3">{b.subject}</td>
                    <td className="py-1 pr-3">{b.status === "draft" ? "草稿" : b.status === "sending" ? "寄送中" : `已寄出 ${fmt(b.finishedAt)}`}</td>
                    <td className="py-1 pr-3 text-xs">{b.stats ? `成功 ${b.stats.sent}・失敗 ${b.stats.failed}・略過 ${b.stats.skipped}・待寄 ${b.stats.queued}` : "-"}</td>
                    <td className="py-1 pr-3">
                      {b.status !== "sent" && (
                        <div className="flex flex-col gap-1">
                          <form action={act} method="post" className="flex items-center gap-1">
                            <input type="hidden" name="action" value="test" />
                            <input type="hidden" name="broadcastId" value={b.id} />
                            <input name="to" type="email" required placeholder="測試收件信箱" className="rounded border px-1" />
                            <button className="rounded border px-2" type="submit">
                              寄測試信
                            </button>
                          </form>
                          <form action={act} method="post" className="flex items-center gap-1">
                            <input type="hidden" name="action" value="send" />
                            <input type="hidden" name="broadcastId" value={b.id} />
                            <label className="flex items-center gap-1">
                              <input type="checkbox" name="confirm" required /> 確認群發給 {subs.counts.confirmed} 人
                            </label>
                            <button className="rounded bg-neutral-900 px-2 text-white" type="submit">
                              {b.status === "sending" ? "繼續寄送" : "群發"}
                            </button>
                          </form>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <form action={act} method="post" className="flex flex-col gap-2 text-sm">
              <input type="hidden" name="action" value="create" />
              <input name="subject" required maxLength={150} placeholder="主旨" className="rounded border px-2 py-1" />
              <textarea name="bodyMd" required rows={6} placeholder="內容（Markdown，寄出時轉成純文字）" className="rounded border px-2 py-1" />
              <div>
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  建立草稿
                </button>
              </div>
            </form>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
