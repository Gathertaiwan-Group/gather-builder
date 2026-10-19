import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { addSection, removeSection, updateSection } from "@/lib/services/sites";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

function parseProps(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new ServiceError("invalid", "props 必須是 JSON 物件");
}

/** 內容編輯：一律走 lib/services/sites（scope content:write、zod 驗證、樂觀鎖、稽核） */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const path = (await req.clone().formData()).get("path");
  const back = `/content?path=${encodeURIComponent(typeof path === "string" ? path : "/")}`;
  return backofficeForm(req, slug, back, async (f, bo) => {
    const action = str(f, "action");
    const p = str(f, "path") || "/";
    if (action === "update") {
      await updateSection(bo.ctx, { site: slug, path: p, sectionId: str(f, "sectionId"), props: parseProps(str(f, "props")), replace: true });
      return { message: "已儲存到草稿（尚未發布）" };
    }
    if (action === "add") {
      const r = await addSection(bo.ctx, { site: slug, path: p, type: str(f, "type"), props: parseProps(str(f, "props")) });
      return { message: `已新增區塊 ${r.sectionId}（草稿）` };
    }
    if (action === "remove") {
      if (f.get("confirm") !== "on") throw new ServiceError("confirm_required", "請勾選確認");
      await removeSection(bo.ctx, { site: slug, path: p, sectionId: str(f, "sectionId") });
      return { message: "已移除（草稿）" };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
