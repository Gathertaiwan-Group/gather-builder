import { cookies } from "next/headers";
import { FLASH_COOKIE } from "@/lib/adminServer";

export async function AdminShell({ children, sp }: { children: React.ReactNode; sp: { ok?: string; err?: string } }) {
  const flash = (await cookies()).get(FLASH_COOKIE)?.value;
  return (
    <div className="min-h-screen" style={{ background: "var(--pf-bg)" }}>
      <header className="border-b bg-white" style={{ borderColor: "var(--pf-line)" }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav className="flex flex-wrap items-center gap-5 text-sm">
            <a href="/admin" className="font-bold no-underline" style={{ color: "var(--pf-text)" }}>
              Gather Builder 後台
            </a>
            <a href="/admin">網站</a>
            <a href="/admin/tokens">MCP Token</a>
          </nav>
          <form action="/api/admin/logout" method="post">
            <button className="text-sm underline" type="submit">
              登出
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        {sp.ok && (
          <p role="status" className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900" data-admin="ok">
            {sp.ok}
          </p>
        )}
        {sp.err && (
          <p role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900" data-admin="err">
            {sp.err}
          </p>
        )}
        {flash && (
          <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
            <p className="m-0 font-semibold">新 token（只會顯示這一次，請立即複製保存）：</p>
            <code className="mt-2 block break-all rounded bg-white p-2" data-admin="flash-token">
              {flash}
            </code>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border bg-white p-5" style={{ borderColor: "var(--pf-line)" }}>
      <h2 className="m-0 mb-4 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
}

export const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";
