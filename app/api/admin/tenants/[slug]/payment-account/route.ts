import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { savePaymentAccount } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

// 🔴 金流憑證唯一的輸入口（MCP 沒有對應工具）。secret 只進加密函式，不寫 log、不回傳。
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/payments", async (f, bo) => {
    await savePaymentAccount(bo.ctx, { site: slug, appId: str(f, "appId"), secret: str(f, "secret"), sandbox: f.get("sandbox") === "on" });
    return { message: "憑證已加密儲存，請按「驗證憑證」確認可用" };
  });
}
