import { getStore } from "@/lib/store";
import { lookupCertificate } from "@/lib/services/certificates";
import { requireSecret } from "@/lib/secrets";
import { clientIp } from "@/lib/client-ip";
import { errorResponse, json } from "@/lib/http";
import { guardJsonPost } from "@/lib/public-post";
import { hashIp } from "@/lib/services/inquiries";

export const dynamic = "force-dynamic";

/** 證照查詢（公開 JSON）：同源＋application/json；查無與不符回同一句話；不回傳生日 */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const blocked = guardJsonPost(req, 2000);
  if (blocked) return blocked;
  try {
    const { site } = await params;
    const tenant = await getStore().getTenantBySlug(site.toLowerCase());
    if (!tenant || tenant.status === "suspended" || !tenant.published_revision_id) return json({ error: "找不到網站" }, 404);
    const data = (await req.json().catch(() => null)) as { certNo?: unknown; name?: unknown; birth?: unknown } | null;
    if (!data || typeof data !== "object") return json({ error: "格式錯誤" }, 400);
    const r = await lookupCertificate(getStore(), tenant, { certNo: data.certNo, name: data.name, birth: data.birth, ipHash: hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")) });
    return json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
