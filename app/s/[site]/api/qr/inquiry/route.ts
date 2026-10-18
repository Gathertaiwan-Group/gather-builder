import { handleOverseasInquiry } from "@/lib/qr-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleOverseasInquiry(req, (await params).site);
}
