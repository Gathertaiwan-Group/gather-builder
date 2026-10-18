import { handleQuote } from "@/lib/shop-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleQuote(req, (await params).site);
}
