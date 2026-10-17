export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { err } = await searchParams;
  return (
    <main className="mx-auto max-w-sm px-4 py-24">
      <h1 className="text-xl font-bold">Gather Builder 後台</h1>
      <form action="/api/admin/login" method="post" className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          密碼
          <input name="password" type="password" required autoComplete="current-password" className="rounded border px-3 py-2" />
        </label>
        {err && <p className="m-0 text-sm text-red-700">{err}</p>}
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-white">
          登入
        </button>
      </form>
    </main>
  );
}
