import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listDocuments } from "@/lib/services/downloads";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function DownloadsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listDocuments(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const act = `/api/admin/tenants/${slug}/downloads/action`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/downloads" name={tenant.name} />
      {"error" in r ? (
        <Card title="文件">
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        </Card>
      ) : (
        <>
          <Card title="上傳文件（4MB 以內；更大的檔案請用 MCP create_document_upload 取得簽名上傳網址）">
            <form action={act} method="post" encType="multipart/form-data" className="flex flex-col gap-2 text-sm">
              <input type="hidden" name="action" value="upload" />
              <input name="title" placeholder="標題" className="rounded border px-3 py-1" required maxLength={160} />
              <input name="category" placeholder="分類（選填）" className="rounded border px-3 py-1" maxLength={40} />
              <input type="file" name="file" required />
              <select name="visibility" className="rounded border px-2 py-1">
                <option value="public">公開</option>
                <option value="members">限會員</option>
              </select>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="publish" /> 直接上架（需勾確認）
              </label>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="confirm" /> 確認
              </label>
              <button className="self-start rounded border px-3 py-1" type="submit">上傳</button>
            </form>
          </Card>
          <Card title={`文件（${r.total}）`}>
            <ul className="m-0 text-sm" data-admin="documents">
              {r.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 py-1">
                  <span>
                    {d.title} · {d.fileName} · {d.visibility === "members" ? "限會員" : "公開"} · {d.status} · 下載 {d.downloads} 次
                  </span>
                  {d.status !== "uploading" && (
                    <form action={act} method="post" className="inline-flex items-center gap-1">
                      <input type="hidden" name="action" value={d.status === "published" ? "unpublish" : "publish"} />
                      <input type="hidden" name="documentId" value={d.id} />
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" name="confirm" required /> 確認
                      </label>
                      <button className="rounded border px-2 py-0.5 text-xs" type="submit">{d.status === "published" ? "下架" : "上架"}</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
