import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { rollback } from "@/lib/services/publish";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "", async (f, bo) => {
    const r = await rollback(bo.ctx, { site: slug, number: Number(str(f, "number")), confirm: f.get("confirm") === "on" });
    return { message: `已還原到第 ${r.publishedRevision} 版（草稿已同步）` };
  });
}
