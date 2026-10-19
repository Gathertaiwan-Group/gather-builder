import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";
import { safeOwnerNext } from "@/lib/owner/routes";

export const dynamic = "force-dynamic";

export default async function OwnerLogin({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; next?: string }> }) {
  const sp = await searchParams;
  return (
    <OwnerAuthShell title="登入" sp={sp}>
      <form action="/api/owner/login" method="post" className="mt-4 flex flex-col gap-3" data-admin="owner-login">
        <input type="hidden" name="next" value={safeOwnerNext(sp.next)} />
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoComplete="username" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          密碼
          <input name="password" type="password" required autoComplete="current-password" className="rounded border px-3 py-2" />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">登入</button>
      </form>
      <p className="mt-4 text-sm">
        <a href="/owner/forgot">忘記密碼</a> · 還沒有網站？<a href="/build">開一個</a>
      </p>
    </OwnerAuthShell>
  );
}
