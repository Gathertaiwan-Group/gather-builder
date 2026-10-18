import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { cancelSession, checkIn } from "@/lib/services/events";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const f0 = await req.clone().formData();
  const session = f0.get("sessionId");
  const back = `/admin/t/${slug}/events${typeof session === "string" && session ? `?session=${encodeURIComponent(session)}` : ""}`;
  return adminForm(req, back, async (f) => {
    const ctx = adminContext(req);
    const confirm = f.get("confirm") === "on";
    const action = str(f, "action");
    if (action === "checkin") {
      const r = await checkIn(ctx, { site: slug, registrationId: str(f, "registrationId") || undefined, code: str(f, "code") || undefined, confirm });
      return { message: r.alreadyCheckedIn ? `${r.contact.name} 已簽到過` : `${r.contact.name}（${r.qty} 位）簽到完成`, redirectTo: back };
    }
    if (action === "cancel_session") {
      const r = await cancelSession(ctx, { site: slug, sessionId: str(f, "sessionId"), reason: str(f, "reason") || undefined, confirm });
      return { message: `場次已取消，已通知 ${r.notified} 筆報名。${r.refundRequired ? r.note : ""}`, redirectTo: back };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
