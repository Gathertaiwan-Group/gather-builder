import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { publishTranslations, translateContent } from "@/lib/services/i18n";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/i18n`, async (f) => {
    const ctx = adminContext(req);
    const action = str(f, "action");
    if (action === "translate_page") {
      const r = await translateContent(ctx, { site: slug, lang: str(f, "lang"), target: { type: "page", path: str(f, "path") } });
      return { message: `已 AI 翻譯 ${r.translated} 個欄位（草稿，發布後上線）` };
    }
    if (action === "publish_entities") {
      const r = await publishTranslations(ctx, { site: slug, lang: str(f, "lang"), confirm: f.get("confirm") === "on" });
      return { message: `已發布 ${r.published} 筆翻譯` };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
