import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { createShipment } from "@/lib/services/shipping";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/shipping", async (f, bo) => {
    const r = await createShipment(bo.ctx, { site: slug, orderNo: str(f, "orderNo"), confirm: f.get("confirm") === "on", trackingNumber: str(f, "tracking") || undefined });
    return { message: r.note };
  });
}
