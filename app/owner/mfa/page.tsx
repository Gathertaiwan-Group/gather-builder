import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";
import { safeOwnerNext } from "@/lib/owner/routes";

export const dynamic = "force-dynamic";

export default async function OwnerMfa({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; next?: string }> }) {
  const sp = await searchParams;
  return (
    <OwnerAuthShell title="二步驟驗證" sp={sp}>
      <form action="/api/owner/mfa" method="post" className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="next" value={safeOwnerNext(sp.next)} />
        <label className="flex flex-col gap-1 text-sm">
          驗證器 App 上的 6 位數驗證碼
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" required autoComplete="one-time-code" className="rounded border px-3 py-2" />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">確認</button>
      </form>
    </OwnerAuthShell>
  );
}
