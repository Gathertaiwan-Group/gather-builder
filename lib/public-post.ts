import { json } from "./http";
import { originOk } from "./site-request";

/**
 * 公開 JSON POST 端點（電子報訂閱、AI 客服、聯絡表單、LINE 點擊、試算…）的共同門檻（2026-10 審查 H-2／M-5）：
 * 1. Origin 必須同源（沒帶 Origin 視為伺服器對伺服器呼叫，仍受各端點限流）；
 * 2. Content-Type 必須是 application/json —— 拒絕 text/plain、form 等「簡單請求」，
 *    別的網站無法不經 CORS 預檢就從訪客瀏覽器打進來；
 * 3. 長度上限。
 * 通過回 null；不通過回錯誤 Response。
 */
export function guardJsonPost(req: Request, maxBytes: number): Response | null {
  if (!originOk(req)) return json({ error: "forbidden origin" }, 403);
  const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return json({ error: "Content-Type 必須是 application/json" }, 415);
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) return json({ error: "內容太長" }, 413);
  return null;
}
