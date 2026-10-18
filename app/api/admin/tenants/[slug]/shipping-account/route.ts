import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { saveShippingAccount } from "@/lib/services/shipping";

export const dynamic = "force-dynamic";

// 🔴 綠界物流憑證唯一的輸入口（MCP 沒有對應工具）。HashKey／HashIV 只進加密函式，不寫 log、不回傳。
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/shipping`, async (f) => {
    await saveShippingAccount(adminContext(req), {
      site: slug,
      merchantId: str(f, "merchantId"),
      hashKey: str(f, "hashKey"),
      hashIv: str(f, "hashIv"),
      stage: f.get("stage") === "on",
      kind: str(f, "kind") === "B2C" ? "B2C" : "C2C",
    });
    return { message: "綠界物流憑證已加密儲存" };
  });
}
