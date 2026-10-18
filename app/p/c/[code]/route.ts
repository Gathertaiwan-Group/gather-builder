import { handleShortLinepayConfirm } from "@/lib/pay-short-routes";

// 第七批審查 H1／H2：金流短網址（見 lib/pay/urls.ts）
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ code: string }> };

export async function GET(req: Request, { params }: P) {
  return handleShortLinepayConfirm(req, (await params).code);
}
