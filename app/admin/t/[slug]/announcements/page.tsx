import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listAnnouncementAcks, listAnnouncements } from "@/lib/services/announcements";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

/** 公告列表與必讀確認名單（完整姓名／email：後台查看會寫稽核） */
export default async function AnnouncementsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; id?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const r = await listAnnouncements(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const roster = sp.id && !("error" in r) ? await listAnnouncementAcks(ctx, { site: slug, announcementId: sp.id, reveal: true }).catch(() => null) : null;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/announcements" name={tenant.name} />
      <Card title="公告">
        {"error" in r ? (
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        ) : (
          <ul className="m-0 text-sm" data-admin="announcements">
            {r.announcements.map((a) => (
              <li key={a.id}>
                {a.pinned ? "📌 " : ""}
                {a.title} · {a.status}
                {a.live ? "（上線中）" : ""} · {a.audience === "members" ? "僅會員" : "所有訪客"}
                {a.requireAck && (
                  <>
                    {" "}· 必讀，已確認 {a.acks} 人 · <a href={`${bo.base}/announcements?id=${a.id}`}>確認名單</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {roster && (
        <Card title={`確認名單：${roster.announcement.title}（${roster.total}）`}>
          <ul className="m-0 text-sm" data-admin="ack-roster">
            {roster.acks.map((k) => (
              <li key={k.memberId}>
                {k.name ?? "（已刪除）"} · {k.email} · {k.ackedAt.slice(0, 19).replace("T", " ")}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </AdminShell>
  );
}
