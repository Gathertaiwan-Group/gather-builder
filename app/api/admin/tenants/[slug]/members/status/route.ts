import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { setMemberStatus } from "@/lib/services/members";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/members`, async (f) => {
    const status = str(f, "status") === "active" ? "active" : "disabled";
    const r = await setMemberStatus(adminContext(req), { site: slug, memberId: str(f, "memberId"), status, confirm: f.get("confirm") === "on" });
    return { message: `${r.email} 已${status === "active" ? "啟用" : "停用"}` };
  });
}
