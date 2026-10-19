import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { getShippingSetupStatus, listShipments } from "@/lib/services/shipping";
import { listOrders } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";
import { SHIPMENT_LABEL } from "@/lib/order-labels";

export const dynamic = "force-dynamic";

export default async function ShippingAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const st = await getShippingSetupStatus(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const [ships, paid] = "error" in st ? [null, null] : await Promise.all([listShipments(ctx, { site: slug, limit: 100 }), listOrders(ctx, { site: slug, status: "paid", limit: 100 })]);
  const shipped = new Set(ships?.shipments.filter((s) => s.status !== "failed" && s.status !== "cancelled").map((s) => s.orderNo) ?? []);
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/shipping" name={tenant.name} />
      {"error" in st ? (
        <Card title="物流">
          <p className="m-0 text-sm text-neutral-600">{st.error}</p>
        </Card>
      ) : (
        <>
          <Card title="運送方式（在 shipping 模組設定，發布後生效）">
            <ul className="m-0 text-sm" data-admin="shipping-methods">
              {st.methods.map((m) => (
                <li key={m.id}>
                  {m.label}（{m.type}／{m.provider}
                  {m.subType ? `／${m.subType}` : ""}）運費 NT${m.fee}
                  {m.freeThreshold !== null && `，滿 NT$${m.freeThreshold} 免運`}
                </li>
              ))}
              {st.methods.length === 0 && <li>尚未設定（shipping 模組 methods）</li>}
            </ul>
          </Card>
          <Card title="綠界物流憑證">
            <p className="mt-0 text-sm" data-admin="ecpay-status">
              {st.ecpay.configured && "stage" in st.ecpay ? (
                <>
                  已設定 · {st.ecpay.kind} · MerchantID {st.ecpay.merchantId} · {st.ecpay.stage ? <strong className="text-amber-700">測試環境（stage，只在預覽結帳可用、不會真的寄送）</strong> : "正式環境"}
                </>
              ) : (
                "尚未設定（超商取貨與綠界宅配不會出現在結帳頁）"
              )}
            </p>
            <form action={`${bo.api}/shipping-account`} method="post" className="flex flex-col gap-2 text-sm" autoComplete="off">
              <p className="m-0 text-xs text-neutral-600">HashKey／HashIV 只在這裡輸入，以 AES-256-GCM 加密存放，任何頁面與 MCP 都讀不到原文。</p>
              <input name="merchantId" required placeholder="MerchantID（特店編號）" className="rounded border px-3 py-1" />
              <input name="hashKey" required type="password" placeholder="HashKey" className="rounded border px-3 py-1" autoComplete="new-password" />
              <input name="hashIv" required type="password" placeholder="HashIV" className="rounded border px-3 py-1" autoComplete="new-password" />
              <select name="kind" className="rounded border px-3 py-1" defaultValue="C2C">
                <option value="C2C">C2C（超商店到店）</option>
                <option value="B2C">B2C（大宗寄倉、宅配）</option>
              </select>
              <label className="flex items-center gap-1">
                <input type="checkbox" name="stage" /> 測試環境（stage）
              </label>
              <div>
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  儲存（加密）
                </button>
              </div>
            </form>
          </Card>
          <Card title="待出貨（已付款、尚無出貨單）">
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {paid?.orders
                .filter((o) => !shipped.has(o.orderNo))
                .map((o) => (
                  <li key={o.orderNo}>
                    <form action={`${bo.api}/shipments/action`} method="post" className="flex flex-wrap items-center gap-2">
                      <span>{o.orderNo}</span>
                      <input type="hidden" name="orderNo" value={o.orderNo} />
                      <input name="tracking" placeholder="手動出貨的追蹤號（綠界免填）" className="rounded border px-2" />
                      <label className="flex items-center gap-1">
                        <input type="checkbox" name="confirm" required /> 確認
                      </label>
                      <button className="rounded border px-2" type="submit">
                        建立出貨單
                      </button>
                    </form>
                  </li>
                ))}
            </ul>
          </Card>
          <Card title="出貨單">
            <table className="w-full text-left text-sm" data-admin="shipment-table">
              <thead>
                <tr>
                  <th className="pr-3">訂單</th>
                  <th className="pr-3">方式</th>
                  <th className="pr-3">狀態</th>
                  <th className="pr-3">追蹤號</th>
                  <th className="pr-3">更新</th>
                </tr>
              </thead>
              <tbody>
                {ships?.shipments.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="py-1 pr-3">{s.orderNo}</td>
                    <td className="py-1 pr-3">
                      {s.subTypeLabel ?? s.type}
                      {s.stage && <span className="ml-1 text-xs text-amber-700">stage</span>}
                    </td>
                    <td className="py-1 pr-3">{SHIPMENT_LABEL[s.status] ?? s.status}</td>
                    <td className="py-1 pr-3">{s.trackingNo ?? "-"}</td>
                    <td className="py-1 pr-3">{fmt(s.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
