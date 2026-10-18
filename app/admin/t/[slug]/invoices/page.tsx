import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { getTenantBySlugAdmin } from "@/lib/services/admin";
import { getInvoiceSetupStatus, listInvoices } from "@/lib/services/invoices";
import { listOrders } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

export default async function InvoicesAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = adminContext();
  const tenant = await getTenantBySlugAdmin(ctx, slug);
  if (!tenant) notFound();
  const st = await getInvoiceSetupStatus(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const [inv, paid] = "error" in st ? [null, null] : await Promise.all([listInvoices(ctx, { site: slug, limit: 100 }), listOrders(ctx, { site: slug, status: "paid", limit: 100 })]);
  const invoiced = new Set(inv?.invoices.map((i) => i.orderNo) ?? []);
  const act = `/api/admin/tenants/${slug}/invoices/action`;
  const base = `/api/admin/tenants/${slug}/invoice-account`;
  return (
    <AdminShell sp={sp}>
      <TenantTabs slug={slug} active="/invoices" name={tenant.name} />
      {"error" in st ? (
        <Card title="電子發票">
          <p className="m-0 text-sm text-neutral-600">{st.error}</p>
        </Card>
      ) : (
        <>
          <Card title="發票憑證（Amego 光貿）">
            <div className="text-sm" data-admin="invoice-status">
              <p className="mt-0">
                invoice 模組狀態：<strong>{st.invoiceModuleStatus}</strong> · 開立時機：<strong>{st.issueMode === "auto_on_paid" ? "付款成功自動開立" : "手動"}</strong>（在 invoice 模組設定 issueMode）
              </p>
              <p>
                {st.account.configured && "provider" in st.account ? (
                  <>
                    供應商 {st.account.provider === "mock" ? "模擬（測試租戶專用）" : "Amego"} · 賣方統編 {st.account.sellerTaxId} · 憑證{" "}
                    <strong data-admin="invoice-account-status">{st.account.status === "verified" ? "已驗證" : "未驗證"}</strong>
                    {st.account.verifiedAt && <> · 驗證於 {fmt(st.account.verifiedAt)}</>}
                  </>
                ) : (
                  "尚未設定憑證"
                )}
              </p>
              {"lastError" in st.account && st.account.lastError && <p className="text-red-700">上次驗證失敗：{st.account.lastError}</p>}
              {!st.relay.configured && (
                <p className="rounded bg-amber-50 p-2 text-amber-800" data-admin="relay-warning">
                  ⚠️ 尚未設定固定 IP 中繼（AMEGO_RELAY_URL／AMEGO_RELAY_SECRET）。Amego 只接受白名單 IP，而本平台的出口 IP 不固定——正式開票前必須設定中繼，並請 Amego 放行中繼的 IP。
                </p>
              )}
            </div>
            {st.account.configured && (
              <form action={`${base}/verify`} method="post" className="mb-4">
                <button className="rounded bg-neutral-900 px-3 py-1 text-sm text-white" type="submit">
                  驗證憑證
                </button>
              </form>
            )}
            <form action={base} method="post" className="flex flex-col gap-2 text-sm" autoComplete="off">
              <p className="m-0 font-semibold">{st.account.configured ? "更換憑證" : "輸入憑證"}</p>
              <p className="m-0 text-xs text-neutral-600">App Key 只在這裡輸入，以 AES-256-GCM 加密存放，任何頁面與 MCP 都讀不到原文。</p>
              <select name="provider" className="rounded border px-3 py-1" defaultValue="amego">
                <option value="amego">Amego（光貿）</option>
                {tenant.is_test && <option value="mock">模擬供應商（測試租戶專用，不會開出真實發票）</option>}
              </select>
              <input name="sellerTaxId" required placeholder="賣方統編（8 碼）" inputMode="numeric" pattern="[0-9]{8}" className="rounded border px-3 py-1" />
              <input name="appKey" type="password" placeholder="Amego App Key（模擬供應商可留空）" className="rounded border px-3 py-1" autoComplete="new-password" />
              <div>
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  儲存（加密）
                </button>
              </div>
            </form>
          </Card>

          <Card title="待開立（已付款、尚無發票）">
            {paid && paid.orders.filter((o) => !invoiced.has(o.orderNo)).length === 0 ? (
              <p className="m-0 text-sm text-neutral-600">沒有待開立的訂單。</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {paid?.orders
                  .filter((o) => !invoiced.has(o.orderNo))
                  .map((o) => (
                    <li key={o.orderNo} className="flex flex-wrap items-center gap-3">
                      {o.orderNo} · {twd(o.total)} {o.paymentSandbox && <span className="text-amber-700">（sandbox 付款，不能開票）</span>}
                      <form action={act} method="post" className="flex items-center gap-2">
                        <input type="hidden" name="action" value="issue" />
                        <input type="hidden" name="orderNo" value={o.orderNo} />
                        <label className="flex items-center gap-1">
                          <input type="checkbox" name="confirm" required /> 確認開立
                        </label>
                        <button className="rounded border px-2" type="submit">
                          開立發票
                        </button>
                      </form>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          <Card title="發票紀錄">
            <table className="w-full text-left text-sm" data-admin="invoice-table">
              <thead>
                <tr>
                  <th className="pr-3">訂單</th>
                  <th className="pr-3">狀態</th>
                  <th className="pr-3">發票號</th>
                  <th className="pr-3">金額</th>
                  <th className="pr-3">動作</th>
                </tr>
              </thead>
              <tbody>
                {inv?.invoices.map((i) => (
                  <tr key={i.orderNo} className="border-t align-top">
                    <td className="py-1 pr-3">{i.orderNo}</td>
                    <td className="py-1 pr-3">
                      {i.statusLabel}
                      {i.error && <div className="text-xs text-red-700">{i.error}</div>}
                    </td>
                    <td className="py-1 pr-3">{i.invoiceNo ?? "-"}</td>
                    <td className="py-1 pr-3">{twd(i.amount)}</td>
                    <td className="py-1 pr-3">
                      {(i.status === "failed" || i.status === "pending" || i.status === "issuing") && (
                        <form action={act} method="post" className="flex items-center gap-1">
                          <input type="hidden" name="action" value="retry" />
                          <input type="hidden" name="orderNo" value={i.orderNo} />
                          <input type="checkbox" name="confirm" required aria-label="確認重試" />
                          <button className="rounded border px-2" type="submit">
                            重試
                          </button>
                        </form>
                      )}
                      {i.status === "issued" && (
                        <form action={act} method="post" className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="action" value="void" />
                          <input type="hidden" name="orderNo" value={i.orderNo} />
                          <input name="reason" placeholder="原因" maxLength={20} className="w-24 rounded border px-1" />
                          <input name="allowanceAmount" placeholder="跨期折讓金額（空白=全額）" inputMode="numeric" className="w-40 rounded border px-1" />
                          <input type="checkbox" name="confirm" required aria-label="確認作廢或折讓" />
                          <button className="rounded border px-2" type="submit">
                            作廢／折讓
                          </button>
                        </form>
                      )}
                    </td>
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
