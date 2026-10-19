import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { publishSite } from "@/lib/services/publish";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "", async (f, bo) => {
    const r = await publishSite(bo.ctx, { site: slug, confirm: f.get("confirm") === "on", note: str(f, "note") || undefined, expectedDraftVersion: str(f, "draftVersion") ? Number(str(f, "draftVersion")) : undefined });
    return { message: `已發布第 ${r.revision} 版` };
  });
}
