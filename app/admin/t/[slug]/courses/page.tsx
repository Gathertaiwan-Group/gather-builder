import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listCourses, listEnrollments } from "@/lib/services/courses";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function CoursesAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listCourses(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const en = "error" in r ? null : await listEnrollments(ctx, { site: slug });
  const act = `/api/admin/tenants/${slug}/courses/action`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/courses" name={tenant.name} />
      <Card title={"error" in r ? "課程" : `課程（${r.courses.length}）`}>
        {"error" in r ? (
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        ) : (
          <ul className="m-0 text-sm">
            {r.courses.map((c) => (
              <li key={c.id} data-admin="course">
                {c.title} <span className="text-neutral-500">/{c.slug} · {c.status} · NT${c.price} · {c.lessons?.length ?? 0} 單元 · 學員 {c.activeEnrollments}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!("error" in r) && (
        <Card title="手動開通／撤銷">
          <form action={act} method="post" className="flex flex-wrap items-center gap-2 text-sm">
            <select name="courseSlug" className="rounded border px-2 py-1">
              {r.courses.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.title}
                </option>
              ))}
            </select>
            <input name="email" type="email" placeholder="會員 Email" className="rounded border px-3 py-1" required />
            <select name="action" className="rounded border px-2 py-1">
              <option value="grant">開通</option>
              <option value="revoke">撤銷</option>
            </select>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="confirm" required />
              確認
            </label>
            <button className="rounded border px-3 py-1" type="submit">
              送出
            </button>
          </form>
        </Card>
      )}
      {en && (
        <Card title={`學員（${en.total}）`}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="py-1 pr-3">課程</th>
                  <th className="py-1 pr-3">會員</th>
                  <th className="py-1 pr-3">狀態</th>
                  <th className="py-1 pr-3">來源</th>
                  <th className="py-1 pr-3">完成</th>
                  <th className="py-1 pr-3">開通時間</th>
                </tr>
              </thead>
              <tbody>
                {en.enrollments.map((e) => (
                  <tr key={e.id} className="border-t" data-admin="enrollment-row">
                    <td className="py-1 pr-3">{e.course}</td>
                    <td className="py-1 pr-3">{e.member}</td>
                    <td className="py-1 pr-3">{e.status === "active" ? "開通中" : "已撤銷"}</td>
                    <td className="py-1 pr-3">{e.source === "order" ? "訂單" : e.source === "manual" ? "手動" : "免費"}</td>
                    <td className="py-1 pr-3">{e.lessonsCompleted}</td>
                    <td className="py-1 pr-3">{fmt(e.grantedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </AdminShell>
  );
}
