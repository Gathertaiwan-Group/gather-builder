import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { listTenants } from "@/lib/services/sites";
import { MODULES } from "@/modules/registry";
import { THEME_PRESETS } from "@/lib/themes";
import { platformPayConfig } from "@/lib/platform/payment";
import { buildTestToken } from "@/lib/services/platform-billing";
import { requireSecret } from "@/lib/secrets";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function AdminHome({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const tenants = await listTenants(adminContext());
  const pay = platformPayConfig();
  const porders = await getStore().listPlatformOrders({ limit: 20 });
  return (
    <AdminShell sp={sp}>
      <Card title={`網站（${tenants.length}）`}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--pf-line)" }}>
                <th className="py-2 pr-4">slug</th>
                <th className="py-2 pr-4">名稱</th>
                <th className="py-2 pr-4">狀態</th>
                <th className="py-2 pr-4">已發布</th>
                <th className="py-2 pr-4">建立</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b" style={{ borderColor: "var(--pf-line)" }} data-admin="tenant-row">
                  <td className="py-2 pr-4">
                    <a href={`/admin/t/${t.slug}`}>{t.slug}</a>
                    {t.is_test && <span className="ml-2 rounded bg-neutral-200 px-1 text-xs">test</span>}
                  </td>
                  <td className="py-2 pr-4">{t.name}</td>
                  <td className="py-2 pr-4">{t.status}</td>
                  <td className="py-2 pr-4">{t.published_revision_id ? "是" : "否"}</td>
                  <td className="py-2 pr-4">{fmt(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="新增網站">
        <form action="/api/admin/tenants" method="post" className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            slug（網址代號）
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" className="rounded border px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            名稱
            <input name="name" required className="rounded border px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            主題
            <select name="themePreset" className="rounded border px-3 py-2">
              {THEME_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-wrap gap-3 text-sm">
            <legend className="mb-1">模組（依賴自動帶入）</legend>
            {MODULES.filter((m) => !m.locked).map((m) => (
              <label key={m.id} className="flex items-center gap-1">
                <input type="checkbox" name="modules" value={m.id} defaultChecked={m.id === "sections-basic"} /> {m.name}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="test" /> 測試網站
          </label>
          <div>
            <button className="rounded bg-neutral-900 px-4 py-2 text-white" type="submit">
              建立
            </button>
          </div>
        </form>
      </Card>
      <Card title="平台收費（/build）">
        <p className="mt-0 text-sm" data-admin="platform-pay">
          平台金流：{pay ? `PChomePay ${pay.sandbox ? "測試環境（sandbox）" : "正式"}` : "未設定（/build 只能試算、顯示尚未開放付款）"}
          {pay?.sandbox && (
            <>
              {" "}
              · <a href={`/build?t=${encodeURIComponent(buildTestToken(requireSecret("PREVIEW_SECRET")))}`}>測試結帳連結（1 小時，只會開 is_test 網站）</a>
            </>
          )}
        </p>
        <ul className="m-0 p-0 text-xs">
          {porders.map((o) => (
            <li key={o.id} className="list-none border-t py-1">
              {o.order_no} · {o.kind} · {o.slug ?? o.brand_name} · NT${o.amount_total} · {o.status} · 開通 {o.provision_state}
              {o.sandbox && "（sandbox）"}
              {o.provision_error && ` · ${o.provision_error}`}
            </li>
          ))}
        </ul>
      </Card>
    </AdminShell>
  );
}
