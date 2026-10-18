import { getStore } from "@/lib/store";
import { subscribe, defaultSender } from "@/lib/services/newsletter";
import { requireSecret } from "@/lib/secrets";
import { clientIp } from "@/lib/client-ip";
import { baseUrlFrom } from "@/lib/runtime";
import { errorResponse, json } from "@/lib/http";
import { guardJsonPost } from "@/lib/public-post";

export const dynamic = "force-dynamic";

/** 電子報訂閱（公開）：一律回同一句話，不洩漏是否已訂閱 */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const blocked = guardJsonPost(req, 4000);
  if (blocked) return blocked;
  try {
    const { site } = await params;
    if (Number(req.headers.get("content-length") ?? 0) > 4000) return json({ error: "內容太長" }, 413);
    const data = (await req.json().catch(() => null)) as { email?: unknown; website?: unknown } | null;
    if (!data || typeof data !== "object") return json({ error: "格式錯誤" }, 400);
    const r = await subscribe({ store: getStore(), baseUrl: baseUrlFrom(req), ipSecret: requireSecret("PREVIEW_SECRET"), send: defaultSender() }, { slug: site.toLowerCase(), ip: clientIp(req), email: data.email, website: data.website });
    return json({ ok: true, message: r.message });
  } catch (e) {
    return errorResponse(e);
  }
}
