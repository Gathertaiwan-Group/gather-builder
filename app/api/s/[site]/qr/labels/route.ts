import { handleLabels } from "@/lib/qr-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleLabels(req, (await params).site);
}
