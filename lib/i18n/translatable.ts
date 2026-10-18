/**
 * 區塊 props 的「可翻譯欄位」：字串葉節點，排除比對鍵／網址／代碼等（slug、id、href、url、email…）。
 * 翻譯值以「欄位路徑」存（例如 title、items.0.body），渲染時只覆蓋「原本就存在且是字串」的位置——
 * 所以翻譯絕對改不到 slug、價格、id 這些比對鍵（記取農經官網 program／category 被翻譯就比對不到的教訓）。
 */

/** 不翻譯的欄位名（最後一段 key；不分大小寫） */
const DENY_KEY = /^(id|slug|href|url|link|src|image|images|icon|logo|email|phone|tel|color|variant|layout|type|style|align|theme|lang|code|sku|key|placement|target|measurementId|lineId|.*Slug|.*Id|.*Url|.*Href|.*Email|.*Code)$/i;
/** 值看起來是網址／路徑／純數字／色碼 → 不翻譯 */
const DENY_VALUE = /^(https?:\/\/|\/|#|mailto:|tel:|\d+(\.\d+)?$)/i;

export function isTranslatableKey(key: string): boolean {
  return !DENY_KEY.test(key);
}

/** 走訪 props，回傳可翻譯的 { 路徑: 原文 } */
export function translatableFields(props: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: unknown, path: string, key: string) => {
    if (typeof v === "string") {
      if (v.trim() && isTranslatableKey(key) && !DENY_VALUE.test(v.trim())) out[path] = v;
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), key));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!isTranslatableKey(k)) continue;
        walk(x, path ? `${path}.${k}` : k, k);
      }
    }
  };
  walk(props, prefix, "");
  return out;
}

/** 依路徑覆蓋：只改「原本存在且為字串、且是可翻譯欄位」的位置；回傳新物件（不改原本的） */
export function applyTranslations<T>(props: T, tr: Record<string, string> | undefined): T {
  if (!tr || !Object.keys(tr).length) return props;
  const allowed = translatableFields(props);
  const copy = structuredClone(props) as unknown;
  for (const [path, text] of Object.entries(tr)) {
    if (!(path in allowed) || typeof text !== "string" || !text.trim()) continue;
    const segs = path.split(".");
    let cur = copy as Record<string, unknown> | unknown[];
    for (let i = 0; i < segs.length - 1; i++) cur = (cur as Record<string, unknown>)[segs[i]!] as Record<string, unknown>;
    const last = segs[segs.length - 1]!;
    if (typeof (cur as Record<string, unknown>)[last] === "string") (cur as Record<string, unknown>)[last] = text;
  }
  return copy as T;
}
