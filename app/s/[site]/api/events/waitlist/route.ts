import { handleEventWaitlist } from "@/lib/class-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleEventWaitlist(req, (await params).site);
}
