import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { verifyProviderAccount } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";
import { PROVIDER_LABEL, isProviderId } from "@/lib/pay/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/payments`, async (f) => {
    const provider = str(f, "provider");
    if (!isProviderId(provider)) throw new ServiceError("invalid", "不支援的金流");
    const r = await verifyProviderAccount(adminContext(req), { site: slug, provider });
    return { message: `${PROVIDER_LABEL[provider]} 驗證成功（${r.sandbox ? "測試環境" : "正式環境"}）${"note" in r && r.note ? `。${r.note}` : ""}` };
  });
}
