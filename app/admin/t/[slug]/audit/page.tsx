import { AdminShell, Card, fmt } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listTenantAudit } from "@/lib/services/owners";

export const dynamic = "force-dynamic";

export default async function AuditPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const logs = await listTenantAudit(bo.ctx, { site: slug, limit: 100 });
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/audit" name={bo.tenant.name} />
      <Card title="稽核紀錄（最近 100 筆）">
        <ul className="m-0 p-0 text-xs" data-admin="audit">
          {logs.map((l) => (
            <li key={l.id} className="list-none break-all border-t py-1">
              {fmt(l.at)} · <strong>{l.action}</strong> · {l.actor} · <code>{JSON.stringify(l.payload).slice(0, 200)}</code>
            </li>
          ))}
        </ul>
      </Card>
    </AdminShell>
  );
}
