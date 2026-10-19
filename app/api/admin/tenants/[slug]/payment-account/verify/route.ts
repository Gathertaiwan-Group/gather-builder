import { backofficeForm } from "@/lib/backoffice";
import { verifyPaymentAccount } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/payments", async (f, bo) => {
    const r = await verifyPaymentAccount(bo.ctx, { site: slug });
    return { message: `驗證成功（${r.sandbox ? "測試環境 sandbox" : "正式環境"}），shop 模組已可使用線上付款` };
  });
}
