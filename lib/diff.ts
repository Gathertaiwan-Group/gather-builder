import type { SiteContent } from "./content";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 已發布 vs 草稿的人類可讀差異摘要（給 agent 回報給使用者看） */
export function diffContent(published: SiteContent | null, draft: SiteContent): string[] {
  if (!published) {
    return [
      "尚未發布過：發布後網站才會上線。",
      ...draft.pages.map((p) => `頁面 ${p.path}「${p.title}」：${p.sections.length} 個區塊（${p.sections.map((s) => s.type).join(", ") || "空"}）`),
    ];
  }
  const out: string[] = [];
  if (!same(published.theme, draft.theme)) {
    out.push(`主題：${published.theme.preset} → ${draft.theme.preset}${same(published.theme.overrides, draft.theme.overrides) ? "" : "（自訂變數有變）"}`);
  }
  if (!same(published.nav, draft.nav)) out.push(`導覽列：${draft.nav.map((n) => n.label).join(" / ")}`);
  const pm = published.moduleSettings ?? {};
  const dm = draft.moduleSettings ?? {};
  for (const id of new Set([...Object.keys(pm), ...Object.keys(dm)])) {
    if (!same(pm[id] ?? {}, dm[id] ?? {})) out.push(`模組 ${id} 設定有變（發布後生效）`);
  }

  const oldPages = new Map(published.pages.map((p) => [p.path, p]));
  const newPages = new Map(draft.pages.map((p) => [p.path, p]));
  for (const [path, p] of newPages) {
    const old = oldPages.get(path);
    if (!old) {
      out.push(`新增頁面 ${path}「${p.title}」（${p.sections.length} 個區塊）`);
      continue;
    }
    if (old.title !== p.title) out.push(`頁面 ${path} 標題：「${old.title}」→「${p.title}」`);
    if (!same(old.seo, p.seo)) out.push(`頁面 ${path} SEO 設定有變`);
    const oldS = new Map(old.sections.map((s) => [s.id, s]));
    const newS = new Map(p.sections.map((s) => [s.id, s]));
    for (const [id, s] of newS) {
      const o = oldS.get(id);
      if (!o) out.push(`頁面 ${path}：新增 ${s.type} 區塊（${id}）`);
      else if (!same(o.props, s.props)) {
        const keys = [...new Set([...Object.keys(o.props), ...Object.keys(s.props)])].filter((k) => !same(o.props[k], s.props[k]));
        out.push(`頁面 ${path}：修改 ${s.type} 區塊（${id}）欄位 ${keys.join(", ")}`);
      }
    }
    for (const [id, s] of oldS) if (!newS.has(id)) out.push(`頁面 ${path}：移除 ${s.type} 區塊（${id}）`);
    const oldOrder = old.sections.map((s) => s.id).filter((id) => newS.has(id));
    const newOrder = p.sections.map((s) => s.id).filter((id) => oldS.has(id));
    if (!same(oldOrder, newOrder)) out.push(`頁面 ${path}：區塊順序調整`);
  }
  for (const [path, p] of oldPages) if (!newPages.has(path)) out.push(`刪除頁面 ${path}「${p.title}」`);
  return out;
}
