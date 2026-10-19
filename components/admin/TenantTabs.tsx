import type { Backoffice } from "@/lib/backoffice";

const TABS = [
  { path: "", label: "總覽" },
  { path: "/members", label: "會員" },
  { path: "/products", label: "商品" },
  { path: "/orders", label: "訂單" },
  { path: "/payments", label: "金流設定" },
  { path: "/invoices", label: "電子發票" },
  { path: "/shipping", label: "物流" },
  { path: "/marketing", label: "行銷" },
  { path: "/newsletter", label: "電子報" },
  { path: "/ai-chat", label: "AI 客服" },
  { path: "/events", label: "活動" },
  { path: "/booking", label: "預約" },
  { path: "/courses", label: "課程" },
  { path: "/loyalty", label: "會員經營" },
  { path: "/i18n", label: "多語" },
  { path: "/downloads", label: "文件" },
  { path: "/certificates", label: "證照" },
  { path: "/reviews", label: "評價" },
  { path: "/announcements", label: "公告" },
  { path: "/subscriptions", label: "訂閱" },
  { path: "/domains", label: "網址" },
];

const OWNER_TABS = [
  { path: "/content", label: "內容編輯" },
  { path: "/team", label: "成員" },
  { path: "/tokens", label: "MCP 連線" },
  { path: "/audit", label: "稽核紀錄" },
];

export function TenantTabs({ bo, active, name }: { bo: Backoffice; active: string; name?: string }) {
  const slug = bo.slug;
  const tabs = bo.mode === "owner" ? [...TABS, ...OWNER_TABS] : [...TABS, { path: "/content", label: "內容編輯" }, { path: "/team", label: "店主成員" }];
  return (
    <>
      {name && (
        <h1 className="mb-3 mt-0 text-2xl font-bold">
          {name} <span className="text-base font-normal text-neutral-500">/{slug}</span>
        </h1>
      )}
      <nav aria-label="網站分頁" className="mb-6 flex flex-wrap gap-2 text-sm" data-admin="tenant-tabs">
        {tabs.map((t) => (
          <a
            key={t.path}
            href={`${bo.base}${t.path}`}
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
