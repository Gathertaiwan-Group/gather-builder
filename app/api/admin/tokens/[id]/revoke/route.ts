import { adminContext } from "@/lib/adminServer";
import { adminForm, backPath } from "@/lib/adminRoute";
import { revokeToken } from "@/lib/services/tokens";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return adminForm(req, backPath(req, "/admin/tokens"), async () => {
    const r = await revokeToken(adminContext(req), { tokenId: id });
    return { message: `已撤銷 token（${r.revokedAt}）` };
  });
}
