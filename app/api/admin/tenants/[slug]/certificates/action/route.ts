import { backofficeForm } from "@/lib/backoffice";
import { importCertificates } from "@/lib/services/certificates";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/certificates", async (f, bo) => {
    const ctx = bo.ctx;
    const file = f.get("file");
    if (!(file instanceof File)) throw new ServiceError("invalid", "請選擇 CSV 檔");
    if (file.size > 2_000_000) throw new ServiceError("invalid", "檔案太大（上限 2MB）");
    const csv = await file.text();
    const r = await importCertificates(ctx, { site: slug, csv, dryRun: f.get("dryRun") === "on", confirm: f.get("confirm") === "on" });
    if (r.errors.length) throw new ServiceError("invalid", r.errors.slice(0, 5).join("；"));
    return { message: "dryRun" in r && r.dryRun ? `驗證通過：${r.rows} 筆（未寫入）` : `已匯入：新增 ${"inserted" in r ? r.inserted : 0}、更新 ${"updated" in r ? r.updated : 0}` };
  });
}
