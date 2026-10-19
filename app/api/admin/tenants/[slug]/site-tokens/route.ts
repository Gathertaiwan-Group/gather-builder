import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { issueOwnerSiteToken, revokeOwnerSiteToken } from "@/lib/services/owners";
import { revokeOAuthGrantForTenant } from "@/lib/services/oauth-grants";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/tokens", async (f, bo) => {
    const action = str(f, "action");
    if (action === "issue") {
      const r = await issueOwnerSiteToken(bo.ctx, { site: slug, name: str(f, "name"), scopes: f.getAll("scopes").map(String) });
      return { message: "已發行（token 只顯示這一次）", flashToken: r.token };
    }
    if (action === "revoke_grant") {
      await revokeOAuthGrantForTenant(bo.ctx, { site: slug, grantId: str(f, "grantId") });
      return { message: "已撤銷 OAuth 授權（access／refresh token 立即失效）" };
    }
    await revokeOwnerSiteToken(bo.ctx, { site: slug, tokenId: str(f, "tokenId") });
    return { message: "已撤銷" };
  });
}
