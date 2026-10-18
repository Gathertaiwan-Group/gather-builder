import { adminContext } from "@/lib/adminServer";
import { adminForm } from "@/lib/adminRoute";
import { verifyPaymentAccount } from "@/lib/services/orders";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/payments`, async () => {
    const r = await verifyPaymentAccount(adminContext(req), { site: slug });
    return { message: `驗證成功（${r.sandbox ? "測試環境 sandbox" : "正式環境"}），shop 模組已可使用線上付款` };
  });
}
