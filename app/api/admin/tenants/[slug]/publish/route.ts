import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { publishSite } from "@/lib/services/publish";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}`, async (f) => {
    const r = await publishSite(adminContext(req), { site: slug, confirm: f.get("confirm") === "on", note: str(f, "note") || undefined });
    return { message: `已發布第 ${r.revision} 版` };
  });
}
