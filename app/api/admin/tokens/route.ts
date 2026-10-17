import { adminContext } from "@/lib/adminServer";
import { adminForm, backPath, str } from "@/lib/adminRoute";
import { issueToken } from "@/lib/services/tokens";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return adminForm(req, backPath(req, "/admin/tokens"), async (f) => {
    const r = await issueToken(adminContext(req), {
      site: str(f, "site") || null,
      name: str(f, "name"),
      scopes: f.getAll("scopes").filter((v): v is string => typeof v === "string"),
    });
    return { message: `已發行 token ${r.prefix}…（原文只顯示一次）`, flashToken: r.token };
  });
}
