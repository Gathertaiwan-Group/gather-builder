import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { inviteTeamMember, updateTeamMember } from "@/lib/services/owners";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/team", async (f, bo) => {
    if (str(f, "action") === "invite") {
      const r = await inviteTeamMember(bo.ctx, { site: slug, email: str(f, "email"), role: str(f, "role") });
      return { message: r.note };
    }
    const status = str(f, "status");
    const r = await updateTeamMember(bo.ctx, { site: slug, membershipId: str(f, "membershipId"), role: str(f, "role") || undefined, status: status === "active" || status === "disabled" ? status : undefined, confirm: f.get("confirm") === "on" });
    return { message: `已更新（${r.role}／${r.status}）` };
  });
}
