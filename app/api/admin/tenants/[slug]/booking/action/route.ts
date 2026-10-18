import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { cancelBooking } from "@/lib/services/booking";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const f0 = await req.clone().formData();
  const week = f0.get("week");
  const back = `/admin/t/${slug}/booking${typeof week === "string" && week ? `?week=${encodeURIComponent(week)}` : ""}`;
  return adminForm(req, back, async (f) => {
    if (str(f, "action") !== "cancel") throw new ServiceError("invalid", "未知動作");
    const r = await cancelBooking(adminContext(req), { site: slug, bookingId: str(f, "bookingId"), reason: str(f, "reason") || undefined, confirm: f.get("confirm") === "on" });
    return { message: `預約已取消並通知客人。${r.refundRequired ? r.note : ""}`, redirectTo: back };
  });
}
