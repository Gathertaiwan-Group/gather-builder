import { handleCourseProgress } from "@/lib/class-routes";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  return handleCourseProgress(req, (await params).site);
}
