import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { verifyProviderAccount } from "@/lib/services/orders";
import { ServiceError } from "@/lib/services/context";
import { PROVIDER_LABEL, isProviderId } from "@/lib/pay/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/payments", async (f, bo) => {
    const provider = str(f, "provider");
    if (!isProviderId(provider)) throw new ServiceError("invalid", "不支援的金流");
    const r = await verifyProviderAccount(bo.ctx, { site: slug, provider });
    return { message: `${PROVIDER_LABEL[provider]} 驗證成功（${r.sandbox ? "測試環境" : "正式環境"}）${"note" in r && r.note ? `。${r.note}` : ""}` };
  });
}
