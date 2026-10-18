import { handleEcpayNotify } from "@/lib/shipping-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 綠界物流狀態通知（ServerReplyURL）：驗 CheckMacValue，正確回純文字 1|OK。
export async function POST(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  return handleEcpayNotify(req, (await params).tenantId);
}
