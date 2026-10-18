import { getStore } from "@/lib/store";
import { chat } from "@/lib/services/ai-chat";
import { geminiFromEnv } from "@/lib/ai/gemini";
import { requireSecret } from "@/lib/secrets";
import { clientIp } from "@/lib/client-ip";
import { errorResponse, json } from "@/lib/http";
import { guardJsonPost } from "@/lib/public-post";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** AI 客服（公開）：限流與租戶隔離在 chat() 內 */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const blocked = guardJsonPost(req, 6000);
  if (blocked) return blocked;
  try {
    const { site } = await params;
    if (Number(req.headers.get("content-length") ?? 0) > 6000) return json({ error: "訊息太長" }, 413);
    const data = (await req.json().catch(() => null)) as { sessionId?: unknown; message?: unknown; path?: unknown } | null;
    if (!data || typeof data !== "object") return json({ error: "格式錯誤" }, 400);
    const r = await chat({ store: getStore(), ipSecret: requireSecret("PREVIEW_SECRET"), gemini: geminiFromEnv() }, { slug: site.toLowerCase(), sessionId: data.sessionId, ip: clientIp(req), message: data.message, path: typeof data.path === "string" ? data.path : undefined });
    return json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
