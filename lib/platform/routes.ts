import { NextResponse } from "next/server";
import { getStore } from "../store";
import { getMailer } from "../mail";
import { requireSecret } from "../secrets";
import { baseUrlFrom } from "../runtime";
import { clientIp } from "../client-ip";
import { formObject } from "../site-request";
import { geminiFromEnv } from "../ai/gemini";
import { hashIp } from "../services/inquiries";
import { ServiceError } from "../errors";
import { createBuildOrder, getBuildQuote, handlePlatformNotify, slugAvailability, startPlatformCheckout, verifyBuildTestToken, type PlatformDeps } from "../services/platform-billing";

/** /build 與平台金流 notify 的 route 實作（app/api/build/*、app/api/platform/* 只是轉呼叫） */
export function platformDeps(req: Request): PlatformDeps {
  return { store: getStore(), baseUrl: baseUrlFrom(req), previewSecret: requireSecret("PREVIEW_SECRET"), sendMail: getMailer(), gemini: geminiFromEnv() };
}

/** sandbox 金鑰只在本機平台網址，或帶平台測試簽章（後台產生，1 小時）時可以結帳 */
export function sandboxAllowed(req: Request, testToken?: string): boolean {
  const host = new URL(baseUrlFrom(req)).hostname;
  return host === "localhost" || host === "127.0.0.1" || verifyBuildTestToken(requireSecret("PREVIEW_SECRET"), testToken);
}

const back = (req: Request, path: string, err?: string) => {
  const u = new URL(path, baseUrlFrom(req));
  if (err) u.searchParams.set("err", err.slice(0, 300));
  return NextResponse.redirect(u, 303);
};
const errText = (e: unknown) => {
  if (e instanceof ServiceError) return e.message;
  console.error(e);
  return "伺服器錯誤，請稍後再試";
};

/** /build 送出：建平台訂單（server 重算價格）→ 建 PChomePay 付款 → 303 到付款頁。付款失敗或未開放 → 303 到訂單頁 */
export async function handleBuildCheckout(req: Request) {
  const store = getStore();
  try {
    const hit = await store.rateHit("build-checkout", hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 3600, 10);
    if (!hit.allowed) throw new ServiceError("rate_limited", "送出太頻繁，請稍後再試");
    const f = await req.formData();
    const modules = f.getAll("modules").map(String);
    const str = (k: string) => (typeof f.get(k) === "string" ? String(f.get(k)) : "");
    const deps = platformDeps(req);
    const r = await createBuildOrder(deps, { modules, themePreset: str("themePreset") || undefined, brandName: str("brandName"), slug: str("slug"), email: str("email") }, { by: `web:${hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")).slice(0, 8)}`, allowSandbox: sandboxAllowed(req, str("t")) });
    try {
      const p = await startPlatformCheckout(deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
      return NextResponse.redirect(p.paymentUrl, 303);
    } catch (e) {
      return NextResponse.redirect(new URL(`${r.statusUrl}&err=${encodeURIComponent(errText(e))}`), 303);
    }
  } catch (e) {
    return back(req, "/build", errText(e));
  }
}

export async function handleBuildPay(req: Request) {
  let path = "/build";
  try {
    const f = await formObject(req);
    path = `/build/orders/${encodeURIComponent(f.orderNo ?? "")}?k=${encodeURIComponent(f.k ?? "")}`;
    const p = await startPlatformCheckout(platformDeps(req), { orderNo: f.orderNo ?? "", accessKey: f.k });
    return NextResponse.redirect(p.paymentUrl, 303);
  } catch (e) {
    return back(req, path, errText(e));
  }
}

export async function handleSlugCheck(req: Request) {
  const store = getStore();
  const hit = await store.rateHit("build-slug", hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 600, 120);
  if (!hit.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const r = await slugAvailability(store, new URL(req.url).searchParams.get("slug"));
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}

export async function handleQuote(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { modules?: unknown };
    return NextResponse.json(getBuildQuote({ modules: body.modules }), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: errText(e) }, { status: 400 });
  }
}

export async function handlePlatformNotifyRoute(req: Request) {
  const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    if (Number(req.headers.get("content-length") ?? 0) > 50_000) return text("success", 200);
    const r = await handlePlatformNotify(platformDeps(req), await req.text());
    if (r.outcome !== "paid") console.log(`[platform/notify] outcome=${r.outcome}`);
    return text(r.body, r.status);
  } catch (e) {
    console.error("[platform/notify] 內部錯誤，回 500 待重試", e);
    return text("retry", 500);
  }
}
