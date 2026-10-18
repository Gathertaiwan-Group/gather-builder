import { getStore } from "@/lib/store";
import { recordLineClick } from "@/lib/services/inquiries";
import { requireSecret } from "@/lib/secrets";
import { clientIp } from "@/lib/client-ip";
import { errorResponse, json } from "@/lib/http";
import { guardJsonPost } from "@/lib/public-post";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const blocked = guardJsonPost(req, 2000);
  if (blocked) return blocked;
  try {
    const { site } = await params;
    const body = (await req.json().catch(() => ({}))) as { path?: unknown; placement?: unknown };
    await recordLineClick(
      { store: getStore(), ipSecret: requireSecret("PREVIEW_SECRET") },
      {
        slug: site,
        ip: clientIp(req),
        path: typeof body.path === "string" ? body.path : undefined,
        placement: typeof body.placement === "string" ? body.placement : undefined,
        userAgent: req.headers.get("user-agent"),
      },
    );
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
