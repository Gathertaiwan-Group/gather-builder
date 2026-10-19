import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";

export const dynamic = "force-dynamic";

// 連結帶一次性 token：referrer 一律不送、不索引
export const metadata = { referrer: "no-referrer" as const, robots: { index: false, follow: false } };

export default async function OwnerReset({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; t?: string }> }) {
  const sp = await searchParams;
  return (
    <OwnerAuthShell title="設定新密碼" sp={sp}>
      <form action="/api/owner/reset" method="post" className="mt-4 flex flex-col gap-3" data-admin="owner-reset">
        <input type="hidden" name="token" value={sp.t ?? ""} />
        <label className="flex flex-col gap-1 text-sm">
          新密碼（至少 8 碼）
          <input name="password" type="password" minLength={8} required autoComplete="new-password" className="rounded border px-3 py-2" />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">更新密碼</button>
      </form>
    </OwnerAuthShell>
  );
}
