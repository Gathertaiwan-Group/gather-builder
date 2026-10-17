import { AdminShell, Card } from "@/components/admin/AdminShell";
import { adminContext, requireAdminPage } from "@/lib/adminServer";
import { listTokens } from "@/lib/services/tokens";
import { ALL_SCOPES } from "@/lib/scopes";
import { TokenTable } from "@/components/admin/TokenTable";

export const dynamic = "force-dynamic";

export default async function TokensPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const ctx = adminContext();
  const [platform, all] = await Promise.all([listTokens(ctx, { tenantId: null }), listTokens(ctx, { tenantId: "all" })]);
  return (
    <AdminShell sp={sp}>
      <Card title="平台級 token（可建站、可操作所有網站）">
        <TokenTable tokens={platform} />
        <form action="/api/admin/tokens" method="post" className="mt-4 flex flex-col gap-2 text-sm">
          <input name="name" required placeholder="用途（例如：Gather 內部 agent）" className="rounded border px-3 py-1" />
          <div className="flex flex-wrap gap-3">
            {ALL_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input type="checkbox" name="scopes" value={s} defaultChecked /> {s}
              </label>
            ))}
          </div>
          <div>
            <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">
              發行平台 token
            </button>
          </div>
        </form>
      </Card>
      <Card title={`所有 token（${all.length}）`}>
        <TokenTable tokens={all} />
      </Card>
    </AdminShell>
  );
}
