import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { issueOwnerSiteToken, revokeOwnerSiteToken } from "@/lib/services/owners";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/tokens", async (f, bo) => {
    const action = str(f, "action");
    if (action === "issue") {
      const r = await issueOwnerSiteToken(bo.ctx, { site: slug, name: str(f, "name"), scopes: f.getAll("scopes").map(String) });
      return { message: "已發行（token 只顯示這一次）", flashToken: r.token };
    }
    await revokeOwnerSiteToken(bo.ctx, { site: slug, tokenId: str(f, "tokenId") });
    return { message: "已撤銷" };
  });
}
