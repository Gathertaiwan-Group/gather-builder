import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { baseUrlFrom } from "@/lib/runtime";
import { verifyPayToken } from "@/lib/pay/notify-token";

// 藍新定期定額 ReturnURL（瀏覽器 POST 導回）：🔴 不讀內容、不改狀態（以 NotifyURL＋權威回查為準），只 303 到會員中心。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handle(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const url = new URL(req.url);
  const s = url.searchParams.get("s") ?? "";
  if (!UUID.test(tenantId) || !verifyPayToken("return", `sub:${s}`, url.searchParams.get("t"))) return new Response("invalid", { status: 400 });
  const tenant = await getStore().getTenantById(tenantId);
  if (!tenant) return new Response("not found", { status: 404 });
  return NextResponse.redirect(`${baseUrlFrom(req).replace(/\/$/, "")}/s/${tenant.slug}/account?ok=${encodeURIComponent("已送出訂閱，確認扣款結果後會寄信通知你（約一分鐘內）")}`, 303);
}

export const POST = handle;
export const GET = handle;
