import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { saveInvoiceAccount } from "@/lib/services/invoices";

export const dynamic = "force-dynamic";

// 🔴 發票憑證唯一的輸入口（MCP 沒有對應工具）。App Key 只進加密函式，不寫 log、不回傳。
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/invoices`, async (f) => {
    const provider = str(f, "provider") === "mock" ? "mock" : "amego";
    await saveInvoiceAccount(adminContext(req), { site: slug, provider, sellerTaxId: str(f, "sellerTaxId"), appKey: str(f, "appKey") });
    return { message: "發票憑證已加密儲存，請按「驗證憑證」確認可用" };
  });
}
