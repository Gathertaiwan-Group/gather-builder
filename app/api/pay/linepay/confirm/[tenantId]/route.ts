import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getMailer } from "@/lib/mail";
import { baseUrlFrom } from "@/lib/runtime";
import { orderPageUrl } from "@/lib/services/shop";
import { handleLinepayConfirm } from "@/lib/services/orders";

// LINE Pay confirmUrl（瀏覽器 GET，沒有簽章）：驗 token＋orderId／transactionId 必須等於付款紀錄 → server 以 DB 金額 confirm（冪等）→ 303 到訂單頁。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  if (!UUID.test(tenantId)) return new Response("invalid", { status: 400 });
  const url = new URL(req.url);
  const sp = url.searchParams;
  const baseUrl = baseUrlFrom(req);
  try {
    const r = await handleLinepayConfirm({ store: getStore(), sendMail: getMailer(), baseUrl }, { tenantId, paymentId: sp.get("p"), token: sp.get("t"), transactionId: sp.get("transactionId"), orderId: sp.get("orderId") });
    if (r.result === "invalid" || !r.tenant || !r.orderNo) return new Response("invalid", { status: 400 });
    return NextResponse.redirect(orderPageUrl(baseUrl, r.tenant, r.orderNo, sp.get("k") ?? undefined), 303);
  } catch (e) {
    console.error("[linepay/confirm] 內部錯誤（逾期前回查會補 confirm）", e);
    const tenant = await getStore().getTenantById(tenantId).catch(() => null);
    const o = sp.get("o") ?? "";
    if (tenant && /^[A-Z0-9]{2,8}-\d{8}-\d{4,}$/.test(o)) return NextResponse.redirect(orderPageUrl(baseUrl, tenant, o, sp.get("k") ?? undefined), 303);
    return new Response("error", { status: 500 });
  }
}
