import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listCertificateLookups, listCertificates } from "@/lib/services/certificates";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export default async function CertificatesAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const r = await listCertificates(ctx, { site: slug, limit: 100 }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const logs = "error" in r ? null : await listCertificateLookups(ctx, { site: slug, limit: 30 });
  const act = `${bo.api}/certificates/action`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/certificates" name={tenant.name} />
      {"error" in r ? (
        <Card title="證照">
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        </Card>
      ) : (
        <>
          <Card title="CSV 匯入（第一列標題：證號,姓名,生日,類別,發證日,到期日,狀態）">
            <form action={act} method="post" encType="multipart/form-data" className="flex flex-col gap-2 text-sm">
              <input type="file" name="file" accept=".csv,text/csv" required />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="dryRun" defaultChecked /> 只驗證不寫入（dry run）
              </label>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name="confirm" /> 確認匯入（同證號覆蓋）
              </label>
              <button className="self-start rounded border px-3 py-1" type="submit">上傳</button>
              <p className="m-0 text-xs text-neutral-600">日期格式 YYYY-MM-DD；欄位以 = + - @ 開頭的會被拒絕（防 CSV injection）；任何一列有錯整份不匯入。</p>
            </form>
          </Card>
          <Card title={`證照（${r.total}）`}>
            <ul className="m-0 text-sm" data-admin="certificates">
              {r.certificates.map((c) => (
                <li key={c.id}>
                  {c.certNo} · {c.name} · {c.category ?? "—"} · {c.issuedOn ?? "—"}～{c.expiresOn ?? "無"} · {c.statusLabel}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="最近查詢紀錄">
            <ul className="m-0 text-xs text-neutral-600">
              {logs?.lookups.map((l, i) => (
                <li key={i}>
                  {l.at.slice(0, 19)} · {l.mode === "cert_no" ? "證號" : "姓名＋生日"} · {l.found ? "查到" : "查無"}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </AdminShell>
  );
}
