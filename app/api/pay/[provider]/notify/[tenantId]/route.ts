import { getStore } from "@/lib/store";
import { getMailer } from "@/lib/mail";
import { baseUrlFrom } from "@/lib/runtime";
import { CALLBACK_RESPONSES, handleProviderNotify } from "@/lib/services/orders";

// 藍新／綠界／PAYUNi／黑貓 的 server 通知（公開）：安全規則見 handleProviderNotify。PChomePay 走 /api/pay/pchomepay/notify（靜態路徑優先）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type P = keyof typeof CALLBACK_RESPONSES;

export async function POST(req: Request, { params }: { params: Promise<{ provider: string; tenantId: string }> }) {
  const { provider, tenantId } = await params;
  if (!Object.hasOwn(CALLBACK_RESPONSES, provider)) return new Response("not found", { status: 404 });
  const fmt = CALLBACK_RESPONSES[provider as P];
  const text = (r: { status: number; body: string }) => new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    if (!UUID.test(tenantId)) return text(fmt.invalid);
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 100_000) return text(fmt.invalid);
    const url = new URL(req.url);
    const rawBody = await req.text();
    const r = await handleProviderNotify(
      { store: getStore(), sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      { provider: provider as P, tenantId, paymentId: url.searchParams.get("p"), token: url.searchParams.get("t"), rawBody, contentType: req.headers.get("content-type") ?? "" },
    );
    if (r.outcome !== "paid") console.log(`[${provider}/notify] tenant=${tenantId} outcome=${r.outcome}`);
    return text(r);
  } catch (e) {
    console.error(`[${provider}/notify] 內部錯誤，要求重送`, e);
    return text(fmt.retry);
  }
}
