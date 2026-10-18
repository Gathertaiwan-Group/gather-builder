const TABS = [
  { path: "", label: "總覽" },
  { path: "/members", label: "會員" },
  { path: "/products", label: "商品" },
  { path: "/orders", label: "訂單" },
  { path: "/payments", label: "金流設定" },
  { path: "/invoices", label: "電子發票" },
  { path: "/shipping", label: "物流" },
];

export function TenantTabs({ slug, active, name }: { slug: string; active: string; name?: string }) {
  return (
    <>
      {name && (
        <h1 className="mb-3 mt-0 text-2xl font-bold">
          {name} <span className="text-base font-normal text-neutral-500">/{slug}</span>
        </h1>
      )}
      <nav aria-label="網站分頁" className="mb-6 flex flex-wrap gap-2 text-sm" data-admin="tenant-tabs">
        {TABS.map((t) => (
          <a
            key={t.path}
            href={`/admin/t/${slug}${t.path}`}
            aria-current={active === t.path ? "page" : undefined}
            className="rounded border px-3 py-1 no-underline"
            style={active === t.path ? { background: "#171717", color: "#fff" } : undefined}
          >
            {t.label}
          </a>
        ))}
      </nav>
    </>
  );
}
