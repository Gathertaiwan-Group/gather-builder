/**
 * Gemini REST（generateContent）。模型預設 gemini-2.5-flash（2026-10-19 以平台既有 key 實測 200；
 * 若新 key 對 2.5-flash 回 404，改用 env GEMINI_MODEL=gemini-3.5-flash，見 memory reference_gemini_model_availability）。
 * 🔴 thinkingBudget 0：思考 token 會吃掉 maxOutputTokens（3.x 預設會思考，回覆會被截斷）。
 */
export type GeminiTurn = { role: "user" | "model"; text: string };
export type GeminiFn = (input: { system: string; turns: GeminiTurn[] }) => Promise<string>;

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function geminiFromEnv(): GeminiFn | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  return async ({ system, turns }) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: { maxOutputTokens: 600, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  };
}
