import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { updateDocument, uploadDocumentDirect } from "@/lib/services/downloads";
import { getFileStorage } from "@/lib/storage/files";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/downloads`, async (f) => {
    const ctx = adminContext(req);
    const action = str(f, "action");
    const confirm = f.get("confirm") === "on";
    if (action === "upload") {
      const file = f.get("file");
      if (!(file instanceof File)) throw new ServiceError("invalid", "請選擇檔案");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await uploadDocumentDirect(ctx, { site: slug, fileName: file.name, bytes, title: str(f, "title"), category: str(f, "category") || undefined, visibility: str(f, "visibility") === "members" ? "members" : "public", publish: f.get("publish") === "on", confirm }, getFileStorage());
      return { message: `已上傳「${r.title}」（${r.status}）` };
    }
    if (action === "publish" || action === "unpublish") {
      const r = await updateDocument(ctx, { site: slug, documentId: str(f, "documentId"), patch: { status: action === "publish" ? "published" : "draft" }, confirm });
      return { message: `「${r.title}」已${r.status === "published" ? "上架" : "下架"}` };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
