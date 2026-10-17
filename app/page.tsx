import { MODULES } from "@/modules/registry";

const CATEGORY: Record<string, string> = { foundation: "底座", content: "內容", engagement: "互動", commerce: "商務" };
const ntd = (n: number) => (n === 0 ? "免費" : `NT$${n.toLocaleString("zh-TW")}`);

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 md:py-20">
      <p className="m-0 text-sm font-semibold tracking-widest" style={{ color: "var(--pf-accent)" }}>
        GATHER BUILDER
      </p>
      <h1 className="mb-4 mt-2 text-[clamp(2rem,1.5rem+2.5vw,3.25rem)] font-bold leading-tight">像組樂高一樣組出你的網站</h1>
      <p className="max-w-2xl text-lg leading-relaxed" style={{ color: "var(--pf-muted)" }}>
        給樂數位把做過的網站功能整理成模組：勾選需要的模組就能開站。平台以 agent 優先設計——你或任何 AI agent 都能透過 MCP
        開站、改內容、加模組；所有修改先進草稿、預覽確認後才發布，每次發布都留版本、可一鍵還原。
      </p>
      <h2 className="mb-4 mt-12 text-xl font-bold">模組目錄</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {MODULES.map((m) => (
          <article key={m.id} className="rounded-xl border p-5" style={{ background: "var(--pf-surface)", borderColor: "var(--pf-line)" }}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="m-0 text-lg font-bold">{m.name}</h3>
              <span className="text-xs" style={{ color: "var(--pf-muted)" }}>
                {CATEGORY[m.category]} · <code>{m.id}</code>
              </span>
            </div>
            <p className="mb-3 mt-2 text-sm leading-relaxed" style={{ color: "var(--pf-muted)" }}>
              {m.description}
            </p>
            <p className="m-0 text-sm">
              建置 <strong>{ntd(m.priceSetup)}</strong>　月費 <strong>{ntd(m.priceMonthly)}</strong>
            </p>
            {m.requires.length > 0 && (
              <p className="mb-0 mt-1 text-xs" style={{ color: "var(--pf-muted)" }}>
                需要：{m.requires.join("、")}
              </p>
            )}
            {m.sectionTypes.length > 0 && (
              <p className="mb-0 mt-1 text-xs" style={{ color: "var(--pf-muted)" }}>
                區塊：{m.sectionTypes.map((s) => s.label).join("、")}
              </p>
            )}
          </article>
        ))}
      </div>
      <p className="mt-12 text-sm" style={{ color: "var(--pf-muted)" }}>
        MCP 端點：<code>/api/mcp</code>（Streamable HTTP，Bearer token）。© 給樂數位 Gather
      </p>
    </main>
  );
}
