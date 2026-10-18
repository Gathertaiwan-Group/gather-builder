import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { baseUrlFrom } from "@/lib/runtime";
import { orderPageUrl } from "@/lib/services/shop";
import { verifyPayToken } from "@/lib/pay/notify-token";

// 藍新／PAYUNi 付款後瀏覽器以 POST 導回：🔴 不讀表單內容、不改任何狀態（付款結果只以 server 通知＋權威回查為準），只 303 到訂單頁（頁面會輪詢）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handle(req: Request, { params }: { params: Promise<{ provider: string; tenantId: string }> }) {
  const { provider, tenantId } = await params;
  if (provider !== "newebpay" && provider !== "payuni") return new Response("not found", { status: 404 });
  const url = new URL(req.url);
  const p = url.searchParams.get("p") ?? "";
  if (!UUID.test(tenantId) || !verifyPayToken("return", p, url.searchParams.get("t"))) return new Response("invalid", { status: 400 });
  const tenant = await getStore().getTenantById(tenantId);
  const orderNo = url.searchParams.get("o") ?? "";
  if (!tenant || !/^[A-Z0-9]{2,8}-\d{8}-\d{4,}$/.test(orderNo)) return new Response("not found", { status: 404 });
  return NextResponse.redirect(orderPageUrl(baseUrlFrom(req), tenant, orderNo, url.searchParams.get("k") ?? undefined), 303);
}

export const POST = handle;
export const GET = handle;
