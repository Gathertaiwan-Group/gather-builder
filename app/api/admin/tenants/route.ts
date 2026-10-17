import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { createSite } from "@/lib/services/sites";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return adminForm(req, "/admin", async (f) => {
    const r = await createSite(adminContext(req), {
      slug: str(f, "slug"),
      name: str(f, "name"),
      modules: f.getAll("modules").filter((v): v is string => typeof v === "string"),
      themePreset: str(f, "themePreset") || undefined,
      test: f.get("test") === "on",
    });
    return { message: `已建立網站 ${r.slug}，預設 token 只顯示這一次`, flashToken: r.token ?? undefined, redirectTo: `/admin/t/${r.slug}` };
  });
}
