import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { listProducts } from "@/lib/services/shop";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const input = "rounded border px-2 py-1";

export default async function ProductsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listProducts(ctx, { site: slug, limit: 100 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const action = `/api/admin/tenants/${slug}/products`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/products" name={tenant.name} />
      {"error" in r ? (
        <Card title="商品">
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        </Card>
      ) : (
        <>
          <Card title={`商品（${r.total}）`}>
            {r.products.length === 0 && <p className="m-0 text-sm text-neutral-500">還沒有商品。</p>}
            <ul className="m-0 flex flex-col gap-3 p-0">
              {r.products.map((p) => (
                <li key={p.id} className="list-none rounded border p-3 text-sm" data-admin="product-row">
                  <form action={`${action}/update`} method="post" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="productId" value={p.id} />
                    <strong className="mr-2 w-full sm:w-auto">
                      {p.name} <span className="font-normal text-neutral-500">/{p.slug}</span>
                      {p.variants.length > 0 && <span className="font-normal text-neutral-500">（{p.variants.length} 個規格）</span>}
                    </strong>
                    <label className="flex flex-col">
                      價格
                      <input name="price" type="number" min={0} defaultValue={p.price} className={`${input} w-24`} />
                    </label>
                    <label className="flex flex-col">
                      庫存
                      <input name="stock" type="number" min={0} defaultValue={p.stock} className={`${input} w-20`} />
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" name="trackInventory" defaultChecked={p.trackInventory} /> 追蹤庫存
                    </label>
                    <label className="flex flex-col">
                      狀態
                      <select name="status" defaultValue={p.status} className={input}>
                        <option value="draft">草稿</option>
                        <option value="published">上架</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="confirm" /> 確認（已上架或要上架時必勾）
                    </label>
                    <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                      儲存
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="新增商品">
            <form action={action} method="post" className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <input name="name" required placeholder="商品名稱" className={input} />
                <input name="slug" required placeholder="網址代號（小寫英數-）" pattern="[a-z0-9][a-z0-9-]*" className={input} />
                <input name="price" type="number" min={0} required placeholder="價格（NT$）" className={`${input} w-32`} />
                <input name="stock" type="number" min={0} placeholder="庫存" className={`${input} w-24`} />
                <label className="flex items-center gap-1">
                  <input type="checkbox" name="trackInventory" /> 追蹤庫存
                </label>
              </div>
              <input name="image" placeholder="圖片 https 網址（選填）" className={input} />
              <textarea name="descriptionMd" placeholder="商品說明（Markdown）" rows={3} className={input} />
              <div className="flex flex-wrap items-center gap-3">
                <select name="status" defaultValue="draft" className={input}>
                  <option value="draft">草稿</option>
                  <option value="published">直接上架</option>
                </select>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" name="confirm" /> 確認（直接上架時必勾）
                </label>
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  新增
                </button>
              </div>
            </form>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
