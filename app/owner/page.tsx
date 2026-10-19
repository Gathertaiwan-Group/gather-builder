import { redirect } from "next/navigation";
import { currentOwnerSession } from "@/lib/owner/routes";
import { ownerSites } from "@/lib/services/owners";
import { getStore } from "@/lib/store";
import { siteBase } from "@/lib/site-url";
import { baseUrlFrom } from "@/lib/runtime";
import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";

export const dynamic = "force-dynamic";

const ROLE = { owner: "擁有者", editor: "編輯", viewer: "檢視者" } as const;

export default async function OwnerHome({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const s = await currentOwnerSession();
  if (!s) redirect("/owner/login");
  const sites = await ownerSites(getStore(), s.user.id);
  return (
    <OwnerAuthShell title="我的網站" sp={sp}>
      <p className="text-sm text-neutral-600">
        {s.user.email} · <a href="/owner/account">帳號與二步驟驗證</a>
      </p>
      {sites.length === 0 ? (
        <p className="text-sm">你還沒有可以管理的網站（邀請可能還沒接受，或已被停用）。</p>
      ) : (
        <ul className="flex flex-col gap-2 p-0" data-admin="owner-sites">
          {sites.map((x) => (
            <li key={x.tenant.id} className="list-none rounded border p-3 text-sm">
              <a href={`/owner/t/${x.tenant.slug}`} className="font-semibold">
                {x.tenant.name}
              </a>{" "}
              · {ROLE[x.role]} · <a href={siteBase(x.tenant, baseUrlFrom(null))}>前台</a>
            </li>
          ))}
        </ul>
      )}
      <form action="/api/owner/logout" method="post">
        <button className="text-sm underline" type="submit">登出</button>
      </form>
    </OwnerAuthShell>
  );
}
