import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { setMemberStatus } from "@/lib/services/members";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/members", async (f, bo) => {
    const status = str(f, "status") === "active" ? "active" : "disabled";
    const r = await setMemberStatus(bo.ctx, { site: slug, memberId: str(f, "memberId"), status, confirm: f.get("confirm") === "on" });
    return { message: `${r.email} 已${status === "active" ? "啟用" : "停用"}` };
  });
}
