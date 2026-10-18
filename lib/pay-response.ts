import { NextResponse } from "next/server";
import { isProviderId, type ProviderId } from "./pay/types";

/** 表單欄位 → 付款方式（只接受已知值，其他回 undefined 交給 zod 回錯） */
export function formPaymentMethod(v: string | undefined): ProviderId | "offline" | undefined {
  if (v === "offline") return "offline";
  return isProviderId(v) ? v : undefined;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 線上付款建單結果 → 瀏覽器回應：導轉（PChomePay、LINE Pay、黑貓）303；表單（藍新、綠界、PAYUNi）回一頁自動送出的 POST 表單。
 * 頁面不載入任何外部資源、no-referrer、不快取；沒有 JS 時顯示按鈕。
 */
export function onlinePaymentResponse(r: { kind: "redirect"; url: string } | { kind: "form"; action: string; fields: Record<string, string> }): Response {
  if (r.kind === "redirect") return NextResponse.redirect(r.url, 303);
  const inputs = Object.entries(r.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>前往付款…</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center"><p>正在前往付款頁…</p><form id="gbpay" method="post" action="${esc(r.action)}">${inputs}<noscript><button type="submit">前往付款</button></noscript></form><script>document.getElementById("gbpay").submit()</script></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
