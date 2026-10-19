export function OwnerAuthShell({ title, children, sp }: { title: string; children: React.ReactNode; sp: { ok?: string; err?: string } }) {
  return (
    <main className="mx-auto max-w-sm px-4 py-20">
      <p className="m-0 text-sm text-neutral-500">Gather Builder 店主後台</p>
      <h1 className="mt-1 text-xl font-bold">{title}</h1>
      {sp.ok && (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-900" data-admin="ok">
          {sp.ok}
        </p>
      )}
      {sp.err && (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-900" data-admin="err">
          {sp.err}
        </p>
      )}
      {children}
    </main>
  );
}
