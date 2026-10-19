import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";

export const dynamic = "force-dynamic";

// 連結帶一次性 token：referrer 一律不送、不索引
export const metadata = { referrer: "no-referrer" as const, robots: { index: false, follow: false } };

export default async function OwnerInvite({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; t?: string }> }) {
  const sp = await searchParams;
  return (
    <OwnerAuthShell title="接受邀請" sp={sp}>
      <form action="/api/owner/invite" method="post" className="mt-4 flex flex-col gap-3" data-admin="owner-invite">
        <input type="hidden" name="token" value={sp.t ?? ""} />
        <label className="flex flex-col gap-1 text-sm">
          你的名字（選填）
          <input name="name" maxLength={80} className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          密碼（至少 8 碼；已經有店主帳號的人可以留空）
          <input name="password" type="password" minLength={8} autoComplete="new-password" className="rounded border px-3 py-2" />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">設定密碼並加入</button>
      </form>
    </OwnerAuthShell>
  );
}
