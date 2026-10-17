import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { rollback } from "@/lib/services/publish";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}`, async (f) => {
    const r = await rollback(adminContext(req), { site: slug, number: Number(str(f, "number")), confirm: f.get("confirm") === "on" });
    return { message: `已還原到第 ${r.publishedRevision} 版（草稿已同步）` };
  });
}
