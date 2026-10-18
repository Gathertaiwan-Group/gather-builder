import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { cancelOrder, fulfillOrder, markOrderPaid } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const orderNo = (await req.clone().formData()).get("orderNo");
  const back = `/admin/t/${slug}/orders${typeof orderNo === "string" ? `?order=${encodeURIComponent(orderNo)}` : ""}`;
  return adminForm(req, back, async (f) => {
    const ctx = adminContext(req);
    const base = { site: slug, orderNo: str(f, "orderNo"), confirm: f.get("confirm") === "on" };
    const action = str(f, "action");
    if (action === "mark_paid") {
      const r = await markOrderPaid(ctx, base);
      return { message: `訂單 ${r.orderNo} 已標記收款`, redirectTo: back };
    }
    if (action === "fulfill") {
      const r = await fulfillOrder(ctx, { ...base, trackingNumber: str(f, "tracking") || undefined });
      return { message: `訂單 ${r.orderNo} 已標記出貨`, redirectTo: back };
    }
    if (action === "cancel") {
      const r = await cancelOrder(ctx, base);
      return { message: `訂單 ${r.orderNo} 已取消。${r.note}`, redirectTo: back };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
