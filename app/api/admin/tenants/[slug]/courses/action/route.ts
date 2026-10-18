import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { grantCourse, revokeCourse } from "@/lib/services/courses";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/courses`, async (f) => {
    const ctx = adminContext(req);
    const base = { site: slug, courseSlug: str(f, "courseSlug"), email: str(f, "email") || undefined, memberId: str(f, "memberId") || undefined, confirm: f.get("confirm") === "on" };
    const action = str(f, "action");
    if (action === "grant") return { message: (await grantCourse(ctx, base)).note };
    if (action === "revoke") return { message: (await revokeCourse(ctx, { ...base, reason: str(f, "reason") || undefined })).note };
    throw new ServiceError("invalid", "未知動作");
  });
}
