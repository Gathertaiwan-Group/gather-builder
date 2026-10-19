import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { adminResetTotp, inviteTeamMember, updateTeamMember } from "@/lib/services/owners";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/team", async (f, bo) => {
    if (str(f, "action") === "invite") {
      const r = await inviteTeamMember(bo.ctx, { site: slug, email: str(f, "email"), role: str(f, "role") });
      return { message: r.note };
    }
    if (str(f, "action") === "reset_totp") {
      const r = await adminResetTotp(bo.ctx, { site: slug, membershipId: str(f, "membershipId"), confirm: f.get("confirm") === "on" });
      return { message: `已重設 ${r.email} 的二步驟驗證（已登出所有裝置）` };
    }
    const status = str(f, "status");
    const r = await updateTeamMember(bo.ctx, { site: slug, membershipId: str(f, "membershipId"), role: str(f, "role") || undefined, status: status === "active" || status === "disabled" ? status : undefined, confirm: f.get("confirm") === "on", revokeTokens: f.get("revokeTokens") === "on" });
    const tok = r.memberTokens ? (r.revokedTokens ? `；已撤銷他建立的 ${r.revokedTokens} 個 MCP token` : `；⚠️ 他建立的 ${r.memberTokens} 個 MCP token 仍有效，勾選「一併撤銷」再送一次或到「MCP 連線」撤銷`) : "";
    return { message: `已更新（${r.role}／${r.status}）${tok}` };
  });
}
