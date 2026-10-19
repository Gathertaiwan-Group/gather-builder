import { OwnerAuthShell } from "@/components/admin/OwnerAuthShell";

export const dynamic = "force-dynamic";

export default async function OwnerForgot({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  return (
    <OwnerAuthShell title="忘記密碼" sp={sp}>
      <form action="/api/owner/forgot" method="post" className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required className="rounded border px-3 py-2" />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">寄送重設連結</button>
      </form>
    </OwnerAuthShell>
  );
}
