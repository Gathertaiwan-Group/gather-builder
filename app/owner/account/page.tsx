import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { FLASH_COOKIE } from "@/lib/adminServer";
import { currentOwnerSession } from "@/lib/owner/routes";
import { decryptSecret } from "@/lib/secretbox";
import { otpauthUri } from "@/lib/owner/totp";
import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function OwnerAccount({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const s = await currentOwnerSession();
  if (!s) redirect("/owner/login?next=/owner/account");
  const u = s.user;
  const flash = (await cookies()).get(FLASH_COOKIE)?.value;
  const pending = !u.totp_enabled_at && u.totp_secret_enc ? decryptSecret(u.totp_secret_enc, `owner-totp:${u.id}`) : null;
  // 第九批審查 M3：每位成員（任何角色）都看得到並能撤銷自己同意過的 AI agent 授權
  const store = getStore();
  const grants = [];
  for (const g of (await store.listOAuthGrants({ userId: u.id, limit: 50 })).filter((x) => !x.revoked_at)) {
    const [c, t] = await Promise.all([store.getOAuthClient(g.client_id), store.getTenantById(g.tenant_id)]);
    grants.push({ id: g.id, client: c?.client_name ?? g.client_id, site: t?.name ?? "（已刪除）", scopes: g.scopes, at: g.created_at.slice(0, 10) });
  }
  return (
    <OwnerAuthShell title="帳號與二步驟驗證" sp={sp}>
      <p className="text-sm">{u.email}</p>
      {flash && /^[a-z0-9]{4}-[a-z0-9]{4}( |$)/.test(flash) && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm" data-admin="recovery-codes">
          <p className="m-0 font-semibold">一次性復原碼（只顯示這一次；手機遺失時可代替驗證碼，每組用一次）：</p>
          <code className="mt-2 block break-all">{flash}</code>
        </div>
      )}
      {u.totp_enabled_at && <p className="text-xs text-neutral-500">剩餘復原碼：{u.totp_recovery_hashes.length} 組</p>}
      {u.totp_enabled_at ? (
        <form action="/api/owner/account" method="post" className="flex flex-col gap-2 text-sm" data-admin="totp-enabled">
          <p className="m-0">二步驟驗證：已啟用</p>
          <input type="hidden" name="action" value="totp_disable" />
          <input name="password" type="password" required autoComplete="current-password" placeholder="目前的密碼" className="rounded border px-3 py-2" />
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" required placeholder="輸入目前的 6 位數碼以停用" className="rounded border px-3 py-2" />
          <button className="rounded border px-3 py-1" type="submit">停用二步驟驗證</button>
        </form>
      ) : pending ? (
        <form action="/api/owner/account" method="post" className="flex flex-col gap-2 text-sm" data-admin="totp-pending">
          <p className="m-0">用驗證器 App（Google Authenticator、1Password…）加入：</p>
          <code className="break-all" data-admin="totp-secret">{pending}</code>
          <code className="break-all text-xs text-neutral-500">{otpauthUri(pending, u.email)}</code>
          <input type="hidden" name="action" value="totp_confirm" />
          <input name="password" type="password" required autoComplete="current-password" placeholder="目前的密碼" className="rounded border px-3 py-2" />
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" required placeholder="6 位數驗證碼" className="rounded border px-3 py-2" />
          <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">完成啟用</button>
        </form>
      ) : (
        <form action="/api/owner/account" method="post" className="text-sm">
          <input type="hidden" name="action" value="totp_begin" />
          <p>二步驟驗證：未啟用（建議擁有者啟用）</p>
          <input name="password" type="password" required autoComplete="current-password" placeholder="目前的密碼" className="mb-2 block rounded border px-3 py-2" />
          <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">開始設定</button>
        </form>
      )}
      <h2 className="mt-6 text-base font-semibold">我授權的 AI agent（{grants.length}）</h2>
      <ul className="m-0 flex flex-col gap-2 p-0 text-sm" data-admin="my-grants">
        {grants.map((g) => (
          <li key={g.id} className="list-none border-b pb-2">
            <b>{g.client}</b> · {g.site} · <span className="text-xs">{g.scopes.join(" ")}</span> · {g.at}
            <form action="/api/owner/account" method="post" className="ml-2 inline">
              <input type="hidden" name="action" value="revoke_grant" />
              <input type="hidden" name="grantId" value={g.id} />
              <button className="rounded border px-2 text-xs" type="submit">撤銷</button>
            </form>
          </li>
        ))}
      </ul>
      <form action="/api/owner/account" method="post" className="mt-6 text-sm">
        <input type="hidden" name="action" value="logout_all" />
        <button className="underline" type="submit">登出所有裝置（含撤銷所有 AI agent 授權）</button>
      </form>
      <p className="text-sm">
        <a href="/owner">回我的網站</a>
      </p>
    </OwnerAuthShell>
  );
}
