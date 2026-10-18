import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { PROVIDER_FIELDS, saveProviderAccount } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";
import { isProviderId } from "@/lib/pay/types";

export const dynamic = "force-dynamic";

// 🔴 第七批：各家金流憑證唯一的輸入口（MCP 沒有對應工具）。secret 只進加密函式，不寫 log、不回傳。
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/payments`, async (f) => {
    const provider = str(f, "provider");
    if (!isProviderId(provider) || provider === "pchomepay") throw new ServiceError("invalid", "不支援的金流");
    const secrets: Record<string, string> = {};
    for (const s of PROVIDER_FIELDS[provider].secrets) secrets[s.key] = str(f, s.key);
    await saveProviderAccount(adminContext(req), { site: slug, provider, appId: str(f, "appId"), secrets, sandbox: f.get("sandbox") === "on" });
    return { message: "憑證已加密儲存，請按「驗證憑證」確認可用" };
  });
}
