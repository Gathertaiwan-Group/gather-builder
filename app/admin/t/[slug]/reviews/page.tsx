import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listReviews } from "@/lib/services/reviews";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function ReviewsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listReviews(ctx, { site: slug, limit: 100 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const act = `/api/admin/tenants/${slug}/reviews/action`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/reviews" name={tenant.name} />
      <Card title={"error" in r ? "評價" : `評價（${r.total}）`}>
        {"error" in r ? (
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        ) : (
          <ul className="m-0 flex flex-col gap-3 text-sm" data-admin="reviews">
            {r.reviews.map((v) => (
              <li key={v.id} className="border-b pb-2">
                {"★".repeat(v.rating)} {v.reviewer} · {v.status} · {v.createdAt.slice(0, 10)}
                <p className="m-0 whitespace-pre-line text-neutral-700">{v.body}</p>
                {v.reply && <p className="m-0 text-xs text-neutral-500">回覆：{v.reply}</p>}
                <form action={act} method="post" className="mt-1 flex flex-wrap items-center gap-2">
                  <input type="hidden" name="reviewId" value={v.id} />
                  <select name="action" className="rounded border px-2 py-0.5 text-xs">
                    <option value="publish">公開</option>
                    <option value="hide">隱藏</option>
                    <option value="reply">回覆</option>
                  </select>
                  <input name="reply" placeholder="回覆內容（選回覆時）" maxLength={1000} className="rounded border px-2 py-0.5 text-xs" />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" name="confirm" required /> 確認
                  </label>
                  <button className="rounded border px-2 py-0.5 text-xs" type="submit">送出</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AdminShell>
  );
}
