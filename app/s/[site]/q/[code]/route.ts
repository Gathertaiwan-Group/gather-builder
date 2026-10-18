import { handleScan } from "@/lib/qr-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ site: string; code: string }> }) {
  const { site, code } = await params;
  return handleScan(req, site, code);
}
