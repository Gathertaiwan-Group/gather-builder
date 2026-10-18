import { DEFAULT_GEMINI_MODEL } from "./gemini";
import { SUPPORTED_LANGS, type LangCode } from "../i18n/langs";

/**
 * AI 翻譯（Gemini REST，JSON 模式）。輸入 { 欄位路徑: 原文 }，輸出同樣的 key。
 * 🔴 只採用「我們送出去的 key」：模型多回的 key 一律丟掉、少回的就維持缺翻譯（fallback 中文）——
 * 所以 AI 不可能新增欄位或改到 slug、價格這些比對鍵（那些根本不會送出去）。
 */
export type Translator = (input: { lang: LangCode; fields: Record<string, string>; glossary?: string; siteName: string }) => Promise<Record<string, string>>;

const MAX_FIELD = 20_000;

export function geminiTranslatorFromEnv(): Translator | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  return async ({ lang, fields, glossary, siteName }) => {
    const target = SUPPORTED_LANGS[lang].ai;
    const system = [
      `You are a professional website localizer. Translate Traditional Chinese (Taiwan) website copy for the brand "${siteName}" into ${target}.`,
      "Return ONLY a JSON object with exactly the same keys as the input; each value is the translated string.",
      "Keep Markdown syntax, line breaks, URLs, email addresses, numbers, prices and product codes unchanged. Do not add explanations.",
      "Keep brand names as-is unless the glossary says otherwise. Use natural, concise marketing tone.",
      glossary ? `Glossary / instructions from the site owner:\n${glossary.slice(0, 2000)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(fields) }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.2, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const out = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    return sanitizeTranslation(fields, parseJsonObject(out));
  };
}

function parseJsonObject(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** 只留我們送出的 key、值必須是非空字串、長度上限 */
export function sanitizeTranslation(source: Record<string, string>, raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const k of Object.keys(source)) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.slice(0, MAX_FIELD);
  }
  return out;
}

/** 測試用（沒有 GEMINI_API_KEY 時只給 is_test 網站）：在每段前面加上 [lang] */
export const mockTranslator: Translator = async ({ lang, fields }) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `[${lang}] ${v}`]));
