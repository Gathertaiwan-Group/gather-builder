import { handleCvsMapReturn } from "@/lib/shipping-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 綠界電子地圖選完門市後，由綠界頁面（跨站）POST 回這裡；安全規則見 handleCvsMapCallback。
export async function POST(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  return handleCvsMapReturn(req, (await params).tenantId);
}
