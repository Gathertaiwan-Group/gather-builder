import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { getOrder, listOrders } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

export default async function OrdersAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; order?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const r = await listOrders(ctx, { site: slug, limit: 100 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const detail = sp.order && !("error" in r) ? await getOrder(ctx, { site: slug, orderNo: sp.order }).catch(() => null) : null;
  const act = `/api/admin/tenants/${slug}/orders/action`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/orders" name={tenant.name} />
      {detail && (
        <Card title={`訂單 ${detail.orderNo}`}>
          <div className="text-sm" data-admin="order-detail">
            <p className="mt-0">
              {detail.statusLabel} · {detail.paymentMethod === "offline" ? "線下匯款" : detail.paymentMethod === "credit" ? "點數／儲值金" : "PChomePay"}
              {detail.paymentSandbox && <strong className="ml-1 rounded bg-amber-100 px-1 text-amber-800" data-admin="sandbox-badge">測試付款・不能出貨</strong>} · 總計 {twd(detail.total)}（小計 {twd(detail.subtotal)}＋運費 {twd(detail.shippingFee)}）
            </p>
            <p>
              訂購人：{detail.contact.name} {detail.contact.email} {detail.contact.phone}
              <br />
              收件：{detail.shipping.name} {detail.shipping.phone} {detail.shipping.address}
              {detail.note && (
                <>
                  <br />
                  備註：{detail.note}
                </>
              )}
            </p>
            <ul>
              {detail.items.map((i, n) => (
                <li key={n}>
                  {i.name}
                  {i.variantLabel ? `（${i.variantLabel}）` : ""} × {i.qty} = {twd(i.lineTotal)}
                </li>
              ))}
            </ul>
            {detail.payments.length > 0 && (
              <p className="text-xs text-neutral-600">
                付款紀錄：{detail.payments.map((p) => `${p.gatewayOrderNo} ${p.status}${p.sandbox ? "（sandbox）" : ""}`).join("；")}
              </p>
            )}
            <div className="flex flex-wrap gap-4">
              {detail.allowedNext.map((next) => {
                const action = next === "paid" ? "mark_paid" : next === "fulfilled" ? "fulfill" : "cancel";
                if (action === "mark_paid" && detail.paymentMethod !== "offline") return null;
                const label = action === "mark_paid" ? "標記已收款" : action === "fulfill" ? "標記已出貨" : "取消訂單";
                return (
                  <form key={action} action={act} method="post" className="flex flex-wrap items-center gap-1">
                    <input type="hidden" name="orderNo" value={detail.orderNo} />
                    <input type="hidden" name="action" value={action} />
                    {action === "fulfill" && <input name="tracking" placeholder="物流單號（選填）" className="rounded border px-2 py-1" />}
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="confirm" required />
                      確認
                    </label>
                    <button type="submit" className="rounded border px-3 py-1">
                      {label}
                    </button>
                  </form>
                );
              })}
            </div>
            {detail.status === "paid" && detail.paymentMethod === "pchomepay" && <p className="text-xs text-amber-700">取消已付款的 PChomePay 訂單不會自動退款，需到 PChomePay 商家後台人工退款。</p>}
          </div>
        </Card>
      )}
      <Card title={"error" in r ? "訂單" : `訂單（${r.total}）`}>
        {"error" in r ? (
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="py-1 pr-3">編號</th>
                  <th className="py-1 pr-3">狀態</th>
                  <th className="py-1 pr-3">付款</th>
                  <th className="py-1 pr-3">金額</th>
                  <th className="py-1 pr-3">訂購人</th>
                  <th className="py-1 pr-3">時間</th>
                </tr>
              </thead>
              <tbody>
                {r.orders.map((o) => (
                  <tr key={o.id} className="border-t" data-admin="order-row">
                    <td className="py-1 pr-3">
                      <a href={`/admin/t/${slug}/orders?order=${encodeURIComponent(o.orderNo)}`}>{o.orderNo}</a>
                    </td>
                    <td className="py-1 pr-3">{o.statusLabel}</td>
                    <td className="py-1 pr-3">
                      {o.paymentMethod === "offline" ? "線下匯款" : o.paymentMethod === "credit" ? "點數／儲值金" : "PChomePay"}
                      {o.paymentSandbox && <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800" data-admin="sandbox-badge">sandbox</span>}
                    </td>
                    <td className="py-1 pr-3">{twd(o.total)}</td>
                    <td className="py-1 pr-3">{o.contactName}</td>
                    <td className="py-1 pr-3">{fmt(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AdminShell>
  );
}
