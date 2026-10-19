import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { activateDomain, addDomain, checkDomain, removeDomain } from "@/lib/services/domains";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/domains`, async (f) => {
    const ctx = adminContext(req);
    const action = str(f, "action");
    const confirm = f.get("confirm") === "on";
    if (action === "add") {
      const r = await addDomain(ctx, { site: slug, domain: str(f, "domain") });
      return { message: `已新增 ${r.domain}，請依頁面設定 DNS` };
    }
    if (action === "check") {
      const r = await checkDomain(ctx, { site: slug, domainId: str(f, "domainId") });
      return { message: r.status === "pending" ? `${r.domain} 尚未驗證：${r.lastError ?? ""}` : `${r.domain} 已驗證` };
    }
    if (action === "activate") {
      const r = await activateDomain(ctx, { site: slug, domainId: str(f, "domainId"), confirm });
      return { message: `${r.domain} 已啟用為正式網址` };
    }
    if (action === "remove") {
      const r = await removeDomain(ctx, { site: slug, domainId: str(f, "domainId"), confirm });
      return { message: `已移除 ${r.removed}` };
    }
    return { message: "未知動作" };
  });
}
