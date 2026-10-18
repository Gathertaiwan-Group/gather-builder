/**
 * 多語（i18n 模組）的語言清單。預設語言 zh-TW 不加網址前綴；其他語言走 /s/<slug>/<lang>/…（middleware 改寫）。
 * 🔴 這些代碼保留給語言前綴：租戶不能建立 /en、/ja… 這類頁面路徑（lib/validators.ts）。
 */
export const DEFAULT_LANG = "zh-TW";

export const SUPPORTED_LANGS = {
  en: { label: "English", html: "en", og: "en_US", ai: "English" },
  ja: { label: "日本語", html: "ja", og: "ja_JP", ai: "Japanese" },
  ko: { label: "한국어", html: "ko", og: "ko_KR", ai: "Korean" },
  "zh-cn": { label: "简体中文", html: "zh-Hans-CN", og: "zh_CN", ai: "Simplified Chinese (Mainland China)" },
  th: { label: "ไทย", html: "th", og: "th_TH", ai: "Thai" },
  vi: { label: "Tiếng Việt", html: "vi", og: "vi_VN", ai: "Vietnamese" },
  id: { label: "Bahasa Indonesia", html: "id", og: "id_ID", ai: "Indonesian" },
  fr: { label: "Français", html: "fr", og: "fr_FR", ai: "French" },
  de: { label: "Deutsch", html: "de", og: "de_DE", ai: "German" },
  es: { label: "Español", html: "es", og: "es_ES", ai: "Spanish" },
} as const;

export type LangCode = keyof typeof SUPPORTED_LANGS;
export const LANG_CODES = Object.keys(SUPPORTED_LANGS) as LangCode[];
export const isLangCode = (v: unknown): v is LangCode => typeof v === "string" && Object.prototype.hasOwnProperty.call(SUPPORTED_LANGS, v);

/** html lang 屬性 */
export function htmlLang(lang: string | null | undefined): string {
  return lang && isLangCode(lang) ? SUPPORTED_LANGS[lang].html : "zh-Hant-TW";
}
export function ogLocale(lang: string | null | undefined): string {
  return lang && isLangCode(lang) ? SUPPORTED_LANGS[lang].og : "zh_TW";
}
export function langLabel(lang: string): string {
  return isLangCode(lang) ? SUPPORTED_LANGS[lang].label : "繁體中文";
}

/** 網站外框的固定字串（模組頁面內的按鈕文字第一版仍為中文，見 ARCHITECTURE 已知限制） */
const UI: Record<string, Record<string, string>> = {
  cart: { "zh-TW": "購物車", en: "Cart", ja: "カート", ko: "장바구니", "zh-cn": "购物车" },
  account: { "zh-TW": "會員", en: "Account", ja: "会員", ko: "회원", "zh-cn": "会员" },
  search: { "zh-TW": "搜尋", en: "Search", ja: "検索", ko: "검색", "zh-cn": "搜索" },
  language: { "zh-TW": "語言", en: "Language", ja: "言語", ko: "언어", "zh-cn": "语言" },
  preview: { "zh-TW": "預覽模式：你看到的是尚未發布的草稿", en: "Preview: unpublished draft", ja: "プレビュー：未公開の下書き" },
};
export function ui(key: keyof typeof UI, lang: string): string {
  return UI[key]?.[lang] ?? UI[key]?.en ?? UI[key]?.["zh-TW"] ?? key;
}
