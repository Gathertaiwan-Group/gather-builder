import { handleCourseBuy } from "@/lib/class-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleCourseBuy(req, (await params).site);
}
