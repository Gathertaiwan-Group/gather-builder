import { handleReportTransfer } from "@/lib/groupbuy-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleReportTransfer(req, (await params).site);
}
