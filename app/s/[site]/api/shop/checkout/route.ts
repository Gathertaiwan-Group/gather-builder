import { handleCheckout } from "@/lib/shop-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleCheckout(req, (await params).site);
}
