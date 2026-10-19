import { redirect } from "next/navigation";
import { currentOwnerSession } from "@/lib/owner/routes";
import { decryptSecret } from "@/lib/secretbox";
import { otpauthUri } from "@/lib/owner/totp";
import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";

export const dynamic = "force-dynamic";

export default async function OwnerAccount({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const s = await currentOwnerSession();
  if (!s) redirect("/owner/login?next=/owner/account");
  const u = s.user;
  const pending = !u.totp_enabled_at && u.totp_secret_enc ? decryptSecret(u.totp_secret_enc, `owner-totp:${u.id}`) : null;
  return (
    <OwnerAuthShell title="帳號與二步驟驗證" sp={sp}>
      <p className="text-sm">{u.email}</p>
      {u.totp_enabled_at ? (
        <form action="/api/owner/account" method="post" className="flex flex-col gap-2 text-sm" data-admin="totp-enabled">
          <p className="m-0">二步驟驗證：已啟用</p>
          <input type="hidden" name="action" value="totp_disable" />
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" required placeholder="輸入目前的 6 位數碼以停用" className="rounded border px-3 py-2" />
          <button className="rounded border px-3 py-1" type="submit">停用二步驟驗證</button>
        </form>
      ) : pending ? (
        <form action="/api/owner/account" method="post" className="flex flex-col gap-2 text-sm" data-admin="totp-pending">
          <p className="m-0">用驗證器 App（Google Authenticator、1Password…）加入：</p>
          <code className="break-all" data-admin="totp-secret">{pending}</code>
          <code className="break-all text-xs text-neutral-500">{otpauthUri(pending, u.email)}</code>
          <input type="hidden" name="action" value="totp_confirm" />
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" required placeholder="6 位數驗證碼" className="rounded border px-3 py-2" />
          <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">完成啟用</button>
        </form>
      ) : (
        <form action="/api/owner/account" method="post" className="text-sm">
          <input type="hidden" name="action" value="totp_begin" />
          <p>二步驟驗證：未啟用（建議擁有者啟用）</p>
          <button className="rounded bg-neutral-900 px-3 py-1 text-white" type="submit">開始設定</button>
        </form>
      )}
      <form action="/api/owner/account" method="post" className="mt-6 text-sm">
        <input type="hidden" name="action" value="logout_all" />
        <button className="underline" type="submit">登出所有裝置</button>
      </form>
      <p className="text-sm">
        <a href="/owner">回我的網站</a>
      </p>
    </OwnerAuthShell>
  );
}
