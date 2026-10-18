import { NextResponse } from "next/server";
import { getStore } from "./store";
import type { Store } from "./store/types";
import { getMailer } from "./mail";
import { baseUrlFrom } from "./runtime";
import { orderPageUrl } from "./services/shop";
import { CALLBACK_RESPONSES, handleLinepayConfirm, handleProviderNotify, type PayDeps } from "./services/orders";
import { handleSubscriptionNotify } from "./services/subscriptions";
import { payToken } from "./pay/notify-token";
import { SHORT_CODE_RE } from "./pay/urls";
import { decryptSecret } from "./secretbox";

/**
 * 第七批審查 H1／H2：短網址 callback（/p/<用途>/<碼>）。<碼> 是付款／訂閱列上的 18 字隨機值，由它在 server 端查回租戶與付款，
 * 再交給原本的處理函式（token 由 server 重算——碼本身就是「只有金流與這筆付款知道」的那道門）。判定照舊：驗簽＋權威回查。
 */
const text = (body: string, status: number) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
type P = keyof typeof CALLBACK_RESPONSES;

async function rawBodyOf(req: Request): Promise<string> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) return new URLSearchParams([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)])).toString();
  return req.text();
}

export async function handleShortNotify(req: Request, code: string, store: Store = getStore()): Promise<Response> {
  if (!SHORT_CODE_RE.test(code)) return text("not found", 404);
  if (Number(req.headers.get("content-length") ?? 0) > 100_000) return text("invalid", 400);
  const payment = await store.getPaymentByShortCode(code);
  if (!payment || !Object.hasOwn(CALLBACK_RESPONSES, payment.provider)) return text("not found", 404);
  const provider = payment.provider as P;
  const fmt = CALLBACK_RESPONSES[provider];
  try {
    const ct = req.headers.get("content-type") ?? "";
    const rawBody = await rawBodyOf(req);
    const r = await handleProviderNotify(
      { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      { provider, tenantId: payment.tenant_id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody, contentType: ct.includes("multipart") ? "application/x-www-form-urlencoded" : ct },
    );
    if (r.outcome !== "paid") console.log(`[${provider}/notify:short] tenant=${payment.tenant_id} outcome=${r.outcome}`);
    return text(r.body, r.status);
  } catch (e) {
    console.error(`[${provider}/notify:short] 內部錯誤，要求重送`, e);
    return text(fmt.retry.body, fmt.retry.status);
  }
}

/** 瀏覽器導回（GET 或 POST）：🔴 不讀內容、不改狀態，只 303 到訂單頁（頁面會輪詢） */
export async function handleShortReturn(req: Request, code: string, store: Store = getStore()): Promise<Response> {
  if (!SHORT_CODE_RE.test(code)) return text("not found", 404);
  const payment = await store.getPaymentByShortCode(code);
  if (!payment) return text("not found", 404);
  const [tenant, order] = await Promise.all([store.getTenantById(payment.tenant_id), store.getOrderById(payment.tenant_id, payment.order_id)]);
  if (!tenant || !order) return text("not found", 404);
  let key: string | undefined;
  try {
    key = payment.return_key_enc ? decryptSecret(payment.return_key_enc, tenant.id) : undefined;
  } catch {
    key = undefined;
  }
  return NextResponse.redirect(orderPageUrl(baseUrlFrom(req), tenant, order.order_no, key), 303);
}

/** LINE Pay confirmUrl（LINE 會在網址後加 transactionId、orderId） */
export async function handleShortLinepayConfirm(req: Request, code: string, store: Store = getStore(), extra: Pick<PayDeps, "providerFor"> = {}): Promise<Response> {
  if (!SHORT_CODE_RE.test(code)) return text("not found", 404);
  const payment = await store.getPaymentByShortCode(code);
  if (!payment || payment.provider !== "linepay") return text("not found", 404);
  const sp = new URL(req.url).searchParams;
  const baseUrl = baseUrlFrom(req);
  try {
    const r = await handleLinepayConfirm({ store, sendMail: getMailer(), baseUrl, ...extra }, { tenantId: payment.tenant_id, paymentId: payment.id, token: payToken("confirm", payment.id), transactionId: sp.get("transactionId"), orderId: sp.get("orderId") });
    if (r.result === "invalid") return text("invalid", 400);
  } catch (e) {
    console.error("[linepay/confirm:short] 內部錯誤（逾期前回查會補 confirm）", e);
  }
  return handleShortReturn(req, code, store);
}

export async function handleShortSubNotify(req: Request, code: string, store: Store = getStore()): Promise<Response> {
  if (!SHORT_CODE_RE.test(code)) return text("not found", 404);
  if (Number(req.headers.get("content-length") ?? 0) > 100_000) return text("invalid", 400);
  const sub = await store.getSubscriptionByShortCode(code);
  if (!sub) return text("not found", 404);
  try {
    const ct = req.headers.get("content-type") ?? "";
    const rawBody = await rawBodyOf(req);
    const r = await handleSubscriptionNotify(
      { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      { tenantId: sub.tenant_id, subscriptionId: sub.id, token: payToken("notify", `sub:${sub.id}`), rawBody, contentType: ct.includes("multipart") ? "application/x-www-form-urlencoded" : ct },
    );
    console.log(`[subscriptions/notify:short] tenant=${sub.tenant_id} outcome=${r.outcome}`);
    return text(r.body, r.status);
  } catch (e) {
    console.error("[subscriptions/notify:short] 內部錯誤，要求重送", e);
    return text("retry", 500);
  }
}

/** 定期定額導回／返回：🔴 不讀內容、不改狀態，只 303 到會員中心 */
export async function handleShortSubReturn(req: Request, code: string, kind: "return" | "back", store: Store = getStore()): Promise<Response> {
  if (!SHORT_CODE_RE.test(code)) return text("not found", 404);
  const sub = await store.getSubscriptionByShortCode(code);
  const tenant = sub ? await store.getTenantById(sub.tenant_id) : null;
  if (!tenant) return text("not found", 404);
  const msg = kind === "return" ? `?ok=${encodeURIComponent("已送出訂閱，確認扣款結果後會寄信通知你（約一分鐘內）")}` : "";
  return NextResponse.redirect(`${baseUrlFrom(req).replace(/\/$/, "")}/s/${tenant.slug}/account${msg}`, 303);
}
