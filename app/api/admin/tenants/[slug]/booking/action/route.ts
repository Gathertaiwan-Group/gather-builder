import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { cancelBooking } from "@/lib/services/booking";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const f0 = await req.clone().formData();
  const week = f0.get("week");
  const back = `/booking${typeof week === "string" && week ? `?week=${encodeURIComponent(week)}` : ""}`;
  return backofficeForm(req, slug, back, async (f, bo) => {
    if (str(f, "action") !== "cancel") throw new ServiceError("invalid", "未知動作");
    const r = await cancelBooking(bo.ctx, { site: slug, bookingId: str(f, "bookingId"), reason: str(f, "reason") || undefined, confirm: f.get("confirm") === "on" });
    return { message: `預約已取消並通知客人。${r.refundRequired ? r.note : ""}`, redirectTo: `${bo.base}${back}` };
  });
}
