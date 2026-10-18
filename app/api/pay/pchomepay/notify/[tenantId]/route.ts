import { getStore } from "@/lib/store";
import { getMailer } from "@/lib/mail";
import { baseUrlFrom } from "@/lib/runtime";
import { handlePchomepayNotify } from "@/lib/services/orders";

// PChomePay notify（公開、無簽章）：安全規則見 handlePchomepayNotify。處理完回純文字 success，回查失敗回 500 讓對方重試。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const { tenantId } = await params;
    if (!UUID.test(tenantId)) return text("success", 200);
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 50_000) return text("success", 200);
    const rawBody = await req.text();
    const r = await handlePchomepayNotify({ store: getStore(), sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenantId, rawBody });
    if (r.outcome !== "paid") console.log(`[pchomepay/notify] tenant=${tenantId} outcome=${r.outcome}`);
    return text(r.body, r.status);
  } catch (e) {
    console.error("[pchomepay/notify] 內部錯誤，回 500 待重試", e);
    return text("retry", 500);
  }
}
