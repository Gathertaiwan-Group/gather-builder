import { notFound } from "next/navigation";
import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { PROVIDER_FIELDS, getPaymentSetupStatus } from "@/lib/services/orders";
import type { ProviderId } from "@/lib/pay/types";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function PaymentsAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const st = await getPaymentSetupStatus(ctx, { site: slug }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const base = `${bo.api}/payment-account`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/payments" name={tenant.name} />
      {"error" in st ? (
        <Card title="金流設定">
          <p className="m-0 text-sm text-neutral-600">{st.error}</p>
        </Card>
      ) : (
        <>
          <Card title="PChomePay 支付連">
            <div className="text-sm" data-admin="payment-status">
              <p className="mt-0">
                shop 模組狀態：<strong>{st.shopModuleStatus}</strong>
                {" · "}
                {st.pchomepay.configured ? (
                  <>
                    憑證 <strong data-admin="payment-account-status">{st.pchomepay.status === "verified" ? "已驗證" : "未驗證"}</strong>
                    {"sandbox" in st.pchomepay && (st.pchomepay.sandbox ? "（測試環境 sandbox）" : "（正式環境）")} · APP ID {"appId" in st.pchomepay ? st.pchomepay.appId : ""}
                    {"verifiedAt" in st.pchomepay && st.pchomepay.verifiedAt && <> · 驗證於 {fmt(st.pchomepay.verifiedAt)}</>}
                  </>
                ) : (
                  "尚未設定憑證"
                )}
              </p>
              {"lastError" in st.pchomepay && st.pchomepay.lastError && <p className="text-red-700">上次驗證失敗：{st.pchomepay.lastError}</p>}
              <p className="text-neutral-600">線下匯款：{st.offlineTransfer.enabled ? "已開放（設定在 shop 模組 offlineTransfer）" : "未開放"}</p>
            </div>
            {st.pchomepay.configured && (
              <form action={`${base}/verify`} method="post" className="mb-4">
                <button className="rounded bg-neutral-900 px-3 py-1 text-sm text-white" type="submit">
                  驗證憑證
                </button>
              </form>
            )}
            <form action={base} method="post" className="flex flex-col gap-2 text-sm" autoComplete="off">
              <p className="m-0 font-semibold">{st.pchomepay.configured ? "更換憑證" : "輸入憑證"}</p>
              <p className="m-0 text-xs text-neutral-600">
                金鑰只在這裡輸入，以 AES-256-GCM 加密存放，任何頁面與 MCP 都讀不到原文。測試金鑰只能用測試環境、正式金鑰只能用正式環境。更換後需重新驗證。
              </p>
              <input name="appId" required placeholder="APP ID" className="rounded border px-3 py-1" autoComplete="off" />
              <input name="secret" required type="password" placeholder="SECRET" className="rounded border px-3 py-1" autoComplete="new-password" />
              <label className="flex items-center gap-1">
                <input type="checkbox" name="sandbox" /> 測試環境（sandbox）——只在預覽模式的結帳可用，已發布網站的訪客看不到線上付款
              </label>
              <div>
                <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                  儲存（加密）
                </button>
              </div>
            </form>
          </Card>
          {st.providers
            .filter((p) => p.provider !== "pchomepay")
            .map((p) => {
              const spec = PROVIDER_FIELDS[p.provider as Exclude<ProviderId, "pchomepay">];
              const pbase = `${bo.api}/payment-provider`;
              return (
                <Card key={p.provider} title={p.label}>
                  <div className="text-sm" data-admin={`provider-${p.provider}`}>
                    <p className="mt-0">
                      {p.configured && "merchantId" in p ? (
                        <>
                          憑證 <strong>{p.status === "verified" ? "已驗證" : "未驗證"}</strong>
                          {p.sandbox ? "（測試環境）" : "（正式環境）"} · 商店代號 {p.merchantId}
                          {p.verifiedAt && <> · 驗證於 {fmt(p.verifiedAt)}</>}
                        </>
                      ) : (
                        "尚未設定憑證"
                      )}
                      {" · "}
                      {p.autoRefund ? "支援後台退款" : "退款需到商家後台"}
                    </p>
                    {"lastError" in p && p.lastError && <p className="text-red-700">上次驗證失敗：{p.lastError}</p>}
                  </div>
                  {p.configured && (
                    <form action={`${pbase}/verify`} method="post" className="mb-4">
                      <input type="hidden" name="provider" value={p.provider} />
                      <button className="rounded bg-neutral-900 px-3 py-1 text-sm text-white" type="submit">
                        驗證憑證
                      </button>
                    </form>
                  )}
                  <form action={pbase} method="post" className="flex flex-col gap-2 text-sm" autoComplete="off">
                    <input type="hidden" name="provider" value={p.provider} />
                    <p className="m-0 font-semibold">{p.configured ? "更換憑證" : "輸入憑證"}</p>
                    <input name="appId" required placeholder={spec.idLabel} className="rounded border px-3 py-1" autoComplete="off" />
                    {spec.secrets.map((f) => (
                      <input key={f.key} name={f.key} required={f.required} type={f.key === "acquirerType" ? "text" : "password"} placeholder={f.label} className="rounded border px-3 py-1" autoComplete="new-password" />
                    ))}
                    <label className="flex items-center gap-1">
                      <input type="checkbox" name="sandbox" /> 測試環境——只在預覽模式的結帳可用，測試付款的訂單不能出貨
                    </label>
                    <div>
                      <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
                        儲存（加密）
                      </button>
                    </div>
                  </form>
                </Card>
              );
            })}
        </>
      )}
    </AdminShell>
  );
}
