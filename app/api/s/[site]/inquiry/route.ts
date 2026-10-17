import { getStore } from "@/lib/store";
import { submitInquiry } from "@/lib/services/inquiries";
import { requireSecret } from "@/lib/secrets";
import { clientIp } from "@/lib/client-ip";
import { getMailer } from "@/lib/mail";
import { errorResponse, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  try {
    const { site } = await params;
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 20_000) return json({ error: "內容太長" }, 413);
    const data = await req.json().catch(() => null);
    if (!data || typeof data !== "object") return json({ error: "格式錯誤" }, 400);
    await submitInquiry(
      { store: getStore(), ipSecret: requireSecret("PREVIEW_SECRET"), sendMail: getMailer() },
      { slug: site, ip: clientIp(req), data },
    );
    // honeypot 命中也回 ok：不讓機器人知道被擋
    return json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
