import { NextResponse } from "next/server";
import { getStore } from "./store";
import type { Store } from "./store/types";
import { requireSecret } from "./secrets";
import { getMailer } from "./mail";
import { baseUrlFrom } from "./runtime";
import { verifyPreviewToken } from "./preview";
import { formObject, messageOf, originOk, siteRedirect } from "./site-request";
import { CVS_RETURN_PATH, cvsCookieName, handleCvsMapCallback, handleLogisticsNotify, startCvsSelection } from "./services/shipping";
import { ServiceError } from "./errors";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * 結帳頁「選擇門市」：建選店暫存 → 設 binding cookie（HttpOnly、path /s/<slug>）→ 回一個自動送出的表單頁，把瀏覽器 POST 到綠界電子地圖。
 * 綠界規定不可用 iframe、iOS 不可另開視窗，所以用整頁導轉。
 */
export async function handleCvsStart(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant || tenant.status === "suspended") return new NextResponse("not found", { status: 404 });
  let back = "/checkout";
  try {
    const f = await formObject(req);
    if (f.returnPath && CVS_RETURN_PATH.test(f.returnPath)) back = f.returnPath;
    const allowStage = !!f.preview && verifyPreviewToken(f.preview, tenant.id, requireSecret("PREVIEW_SECRET")).ok;
    const r = await startCvsSelection(store, tenant, { methodId: f.methodId ?? "", baseUrl: baseUrlFrom(req), mobile: /Mobile|Android|iPhone/i.test(req.headers.get("user-agent") ?? ""), allowStage, returnPath: f.returnPath || null });
    const inputs = Object.entries(r.form.fields)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("");
    const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>前往選擇門市</title></head><body style="font-family:system-ui;padding:24px"><form id="f" method="post" action="${esc(r.form.action)}">${inputs}<p>正在前往超商電子地圖…</p><button type="submit">若沒有自動跳轉，請按這裡</button></form><script>document.getElementById("f").submit()</script></body></html>`;
    const res = new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    res.cookies.set(cvsCookieName(tenant.id), r.binding, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: `/s/${slug}`, maxAge: r.maxAgeSeconds });
    return res;
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}

/** 綠界電子地圖回傳（從綠界頁面跨站 POST）：寫回門市 → 303 回結帳頁 */
export async function handleCvsMapReturn(req: Request, tenantId: string, store: Store = getStore()): Promise<Response> {
  const form = await formObject(req).catch(() => ({}) as Record<string, string>);
  const r = await handleCvsMapCallback(store, tenantId, form);
  if (!r.slug) return new NextResponse("not found", { status: 404 });
  return siteRedirect(req, r.slug, r.returnPath ?? "/checkout", r.ok ? undefined : { err: r.message }, r.ok && r.selectionId ? { cvs: r.selectionId } : undefined);
}

/** 綠界物流狀態通知：驗 CheckMacValue，回純文字 1|OK */
export async function handleEcpayNotify(req: Request, tenantId: string, store: Store = getStore()): Promise<Response> {
  try {
    const raw = await req.text();
    const r = await handleLogisticsNotify({ store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenantId, rawBody: raw });
    return new NextResponse(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    console.error("[ecpay/notify] 例外", e instanceof ServiceError ? e.message : e);
    return new NextResponse("0|Error", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
