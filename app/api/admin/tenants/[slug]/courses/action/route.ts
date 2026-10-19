import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { grantCourse, revokeCourse } from "@/lib/services/courses";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/courses", async (f, bo) => {
    const ctx = bo.ctx;
    const base = { site: slug, courseSlug: str(f, "courseSlug"), email: str(f, "email") || undefined, memberId: str(f, "memberId") || undefined, confirm: f.get("confirm") === "on" };
    const action = str(f, "action");
    if (action === "grant") return { message: (await grantCourse(ctx, base)).note };
    if (action === "revoke") return { message: (await revokeCourse(ctx, { ...base, reason: str(f, "reason") || undefined })).note };
    throw new ServiceError("invalid", "未知動作");
  });
}
