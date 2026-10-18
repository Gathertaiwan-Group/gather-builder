/** 會員頁共用外框與訊息（server component，表單直接 POST，不需要前端 JS） */
export function AccountPanel({ title, children, sp }: { title: string; children: React.ReactNode; sp?: { ok?: string; err?: string } }) {
  return (
    <section className="gb-section">
      <div className="gb-container max-w-md">
        <h1 className="gb-h2">{title}</h1>
        {sp?.ok && (
          <p role="status" className="gb-card mb-4 p-3 text-sm" data-gb="ok">
            {sp.ok}
          </p>
        )}
        {sp?.err && (
          <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">
            {sp.err}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

export function Field({ label, ...rest }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input className="gb-input" {...rest} />
    </label>
  );
}
