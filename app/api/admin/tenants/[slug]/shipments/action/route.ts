import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { createShipment } from "@/lib/services/shipping";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/shipping`, async (f) => {
    const r = await createShipment(adminContext(req), { site: slug, orderNo: str(f, "orderNo"), confirm: f.get("confirm") === "on", trackingNumber: str(f, "tracking") || undefined });
    return { message: r.note };
  });
}
