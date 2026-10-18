import { getStore } from "@/lib/store";
import { getMailer } from "@/lib/mail";
import { baseUrlFrom } from "@/lib/runtime";
import { handleSubscriptionNotify } from "@/lib/services/subscriptions";

// 藍新信用卡定期定額 NotifyURL（建立委託結果＋每期授權）：安全規則見 handleSubscriptionNotify。藍新只認 HTTP 200。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const { tenantId } = await params;
    if (!UUID.test(tenantId)) return text("invalid", 400);
    if (Number(req.headers.get("content-length") ?? 0) > 100_000) return text("invalid", 400);
    const url = new URL(req.url);
    const ct = req.headers.get("content-type") ?? "";
    // 手冊 FAQ：通知可能是 x-www-form-urlencoded 或 multipart/form-data
    const rawBody = ct.includes("multipart/form-data") ? new URLSearchParams([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)])).toString() : await req.text();
    const r = await handleSubscriptionNotify({ store: getStore(), sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenantId, subscriptionId: url.searchParams.get("s"), token: url.searchParams.get("t"), rawBody, contentType: ct.includes("multipart") ? "application/x-www-form-urlencoded" : ct });
    console.log(`[subscriptions/notify] tenant=${tenantId} outcome=${r.outcome}`);
    return text(r.body, r.status);
  } catch (e) {
    console.error("[subscriptions/notify] 內部錯誤，要求重送", e);
    return text("retry", 500);
  }
}
