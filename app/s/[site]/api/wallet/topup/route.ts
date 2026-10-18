import { handleTopupBuy } from "@/lib/class-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleTopupBuy(req, (await params).site);
}
