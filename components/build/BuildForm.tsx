"use client";

import { useEffect, useMemo, useState } from "react";

export type CatalogItem = { id: string; name: string; description: string; category: string; priceSetup: number; priceMonthly: number; requires: string[]; base: boolean };

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const CAT: Record<string, string> = { foundation: "基礎", content: "內容", engagement: "互動與會員", commerce: "交易" };

/** 只用來即時顯示；送出後 server 依註冊表重算（前端價格不採信） */
function closure(catalog: CatalogItem[], picked: string[]) {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const r of byId.get(id)?.requires ?? []) visit(r);
  };
  for (const c of catalog) if (c.base) visit(c.id);
  for (const id of picked) visit(id);
  return out;
}

export function BuildForm({ catalog, themes, paymentsOpen, sandbox, testToken }: { catalog: CatalogItem[]; themes: { id: string; name: string }[]; paymentsOpen: boolean; sandbox: boolean; testToken: string | null }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [slug, setSlug] = useState("");
  const [slugState, setSlugState] = useState<{ available: boolean; reason?: string } | null>(null);
  const all = useMemo(() => closure(catalog, picked), [catalog, picked]);
  const lines = catalog.filter((c) => all.has(c.id));
  const setup = lines.reduce((a, l) => a + l.priceSetup, 0);
  const monthly = lines.reduce((a, l) => a + l.priceMonthly, 0);

  useEffect(() => {
    if (!slug) return setSlugState(null);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/build/slug?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
        setSlugState(r.ok ? await r.json() : null);
      } catch {
        setSlugState(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [slug]);

  const groups = [...new Set(catalog.filter((c) => !c.base).map((c) => c.category))];
  return (
    <form action="/api/build/checkout" method="post" className="grid gap-8 md:grid-cols-[1fr_320px]" data-build="form">
      {testToken && <input type="hidden" name="t" value={testToken} />}
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <fieldset key={g} className="rounded-xl border bg-white p-4">
            <legend className="px-1 font-semibold">{CAT[g] ?? g}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {catalog
                .filter((c) => c.category === g && !c.base)
                .map((c) => {
                  const on = picked.includes(c.id);
                  const auto = !on && all.has(c.id);
                  return (
                    <label key={c.id} className="flex cursor-pointer gap-2 rounded-lg border p-3 text-sm" style={on || auto ? { borderColor: "#171717" } : undefined} data-build="module" data-module={c.id}>
                      <input type="checkbox" name="modules" value={c.id} checked={on} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
                      <span>
                        <b>{c.name}</b> {auto && <span className="text-xs text-amber-700" data-build="auto">（依賴自動帶入）</span>}
                        <span className="block text-neutral-600">{c.description}</span>
                        <span className="block text-xs text-neutral-500">
                          建置 {twd(c.priceSetup)} · 月費 {twd(c.priceMonthly)}
                          {c.requires.length > 0 && ` · 需要 ${c.requires.join("、")}`}
                        </span>
                      </span>
                    </label>
                  );
                })}
            </div>
          </fieldset>
        ))}
        <fieldset className="flex flex-col gap-3 rounded-xl border bg-white p-4 text-sm">
          <legend className="px-1 font-semibold">網站資料</legend>
          <label className="flex flex-col gap-1">
            品牌名稱
            <input name="brandName" required maxLength={120} className="rounded border px-3 py-2" />
          </label>
          <label className="flex flex-col gap-1">
            想要的網址代號（小寫英數與 -）
            <input name="slug" required pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className="rounded border px-3 py-2" />
            {slugState && (
              <span className={slugState.available ? "text-green-700" : "text-red-700"} data-build="slug-state">
                {slugState.available ? "可以使用" : slugState.reason}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            版型
            <select name="themePreset" className="rounded border px-3 py-2">
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            聯絡 Email（付款後寄店主後台邀請）
            <input name="email" type="email" required className="rounded border px-3 py-2" />
          </label>
        </fieldset>
      </div>
      <aside className="h-fit rounded-xl border bg-white p-4 text-sm md:sticky md:top-4" data-build="summary">
        <h2 className="mt-0 text-base font-bold">試算</h2>
        <ul className="m-0 flex flex-col gap-1 p-0">
          {lines.map((l) => (
            <li key={l.id} className="flex list-none justify-between gap-2">
              <span>{l.name}</span>
              <span className="text-neutral-500">{twd(l.priceSetup)}</span>
            </li>
          ))}
        </ul>
        <p className="mb-0 mt-3 flex justify-between border-t pt-2">
          <span>建置費</span> <b data-build="setup">{twd(setup)}</b>
        </p>
        <p className="m-0 flex justify-between">
          <span>月費</span> <b data-build="monthly">{twd(monthly)}</b>
        </p>
        <p className="m-0 flex justify-between">
          <span>首次付款（建置＋第一個月）</span> <b data-build="first">{twd(setup + monthly)}</b>
        </p>
        <p className="text-xs text-neutral-500">之後每月寄帳單連結，可隨時停止續費（到期後停站，資料保留）。實際金額以結帳時伺服器計算為準。</p>
        {paymentsOpen ? (
          <button type="submit" className="w-full rounded bg-neutral-900 px-4 py-2 text-white" data-build="submit">
            {sandbox ? "前往付款（測試環境）" : "前往付款"}
          </button>
        ) : (
          <p className="rounded bg-amber-50 p-2 text-amber-900" data-build="closed">
            尚未開放付款，目前只能試算。
          </p>
        )}
      </aside>
    </form>
  );
}
