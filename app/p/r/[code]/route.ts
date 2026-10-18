import { handleShortReturn } from "@/lib/pay-short-routes";

// 第七批審查 H1／H2：金流短網址（見 lib/pay/urls.ts）
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type P = { params: Promise<{ code: string }> };

async function handle(req: Request, { params }: P) {
  return handleShortReturn(req, (await params).code);
}
export const GET = handle;
export const POST = handle;
