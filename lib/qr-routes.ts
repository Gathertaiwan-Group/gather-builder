import { NextResponse } from "next/server";
import { getStore } from "./store";
import type { Store } from "./store/types";
import { requireSecret } from "./secrets";
import { getMailer } from "./mail";
import { baseUrlFrom } from "./runtime";
import { clientIp } from "./client-ip";
import { loadSite, moduleActive } from "./site-loader";
import { hashIp } from "./services/inquiries";
import { QR_CODE_RE, qrShortUrl, readScanCookie, recordScan, scanCookieName, signScanCookie, submitOverseasInquiry, verifyLabelsUrl } from "./services/qrcatalog";
import { formObject, messageOf, originOk } from "./site-request";
import { cookieValue } from "./shop-routes";
import { qrPng, qrSvg } from "./qr";
import { DEFAULT_LANG, isLangCode } from "./i18n/langs";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const langPrefix = (lang: string) => (lang && lang !== DEFAULT_LANG ? `/${lang}` : "");

/**
 * 掃碼短連結 /s/<slug>/q/<碼>：記錄掃描（不存 IP；國家只用 x-vercel-ip-country）→ 設歸因 cookie（最近 10 次掃描，HMAC）→ 303 到該語言的落地頁。
 */
export async function handleScan(req: Request, rawSlug: string, code: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!QR_CODE_RE.test(code)) return new NextResponse("not found", { status: 404 });
  const site = await loadSite(slug, null, store, { lang: null });
  if (!site || !moduleActive(site, "qr-catalog")) return new NextResponse("not found", { status: 404 });
  const r = await recordScan(store, site.tenant, { code, acceptLanguage: req.headers.get("accept-language"), headers: req.headers, ipHash: hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), enabledLangs: site.languages });
  if (!r) return new NextResponse("not found", { status: 404 });
  const res = NextResponse.redirect(new URL(`/s/${slug}${langPrefix(r.lang)}/q/${code}/view`, baseUrlFrom(req)), 303);
  res.headers.set("cache-control", "no-store");
  if (r.scanId) {
    const name = scanCookieName(site.tenant.id);
    const ids = [...readScanCookie(site.tenant.id, cookieValue(req, name)), r.scanId];
    res.cookies.set(name, signScanCookie(site.tenant.id, ids), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: `/s/${slug}`, maxAge: 30 * 86400 });
  }
  return res;
}

const DONE: Record<string, string> = { "zh-TW": "已收到你的詢價，店家會以 Email 回覆報價。", en: "Thanks! The shop will email you a shipping quote.", ja: "お問い合わせを受け付けました。送料のお見積りをメールでお送りします。" };

/** 海外寄送詢價（落地頁表單 POST） */
export async function handleOverseasInquiry(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) return new NextResponse("not found", { status: 404 });
  const f = await formObject(req).catch(() => ({}) as Record<string, string>);
  const code = QR_CODE_RE.test(f.code ?? "") ? f.code! : "";
  const lang = f.lang && (f.lang === DEFAULT_LANG || isLangCode(f.lang)) ? f.lang : DEFAULT_LANG;
  const back = (msg: Record<string, string>) => {
    const u = new URL(`/s/${slug}${langPrefix(lang)}/q/${code}/view`, baseUrlFrom(req));
    for (const [k, v] of Object.entries(msg)) u.searchParams.set(k, v.slice(0, 300));
    return NextResponse.redirect(u, 303);
  };
  if (!code) return new NextResponse("not found", { status: 404 });
  try {
    const scanIds = readScanCookie(tenant.id, cookieValue(req, scanCookieName(tenant.id)));
    await submitOverseasInquiry({ store, sendMail: getMailer() }, { tenant, data: { code, lang, name: f.name ?? "", email: (f.email ?? "").trim(), country: f.country ?? "", address: f.address ?? "", message: f.message || undefined, website: f.website || undefined }, scanIds, ipHash: hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")) });
    return back({ ok: DONE[lang] ?? DONE.en! });
  } catch (e) {
    return back({ err: messageOf(e) });
  }
}

/** A4 標籤頁（簽章網址、1 小時有效）：一頁 3×7＝21 張（商品名、價格、QR、短碼） */
export async function handleLabels(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) return new NextResponse("not found", { status: 404 });
  const sp = new URL(req.url).searchParams;
  const codes = verifyLabelsUrl(tenant, sp.get("c") ?? "", sp.get("exp") ?? "", sp.get("t") ?? "");
  if (!codes) return new NextResponse("連結無效或已過期，請重新產生（generate_qr_labels）", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const qrs = await store.listQrCodes(tenant.id, { codes });
  const products = await store.getProductsByIds(tenant.id, qrs.map((q) => q.product_id));
  const base = baseUrlFrom(req);
  const cells: string[] = [];
  for (const c of codes) {
    const q = qrs.find((x) => x.code === c);
    const p = q ? products.find((x) => x.id === q.product_id) : null;
    if (!q || !p) continue;
    cells.push(`<div class="l"><div class="q">${await qrSvg(qrShortUrl(base, tenant, q.code))}</div><div class="t"><b>${esc(p.name)}</b><span class="p">${twd(p.price)}</span><span class="c">${esc(q.code)}</span></div></div>`);
  }
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>QR 標籤｜${esc(tenant.name)}</title><style>@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;font-family:system-ui,"Noto Sans TC",sans-serif}.g{display:grid;grid-template-columns:repeat(3,63mm);grid-auto-rows:38mm;gap:2mm;justify-content:center}.l{border:1px dashed #bbb;padding:2mm;display:flex;gap:2mm;align-items:center;overflow:hidden;break-inside:avoid}.q{width:30mm;height:30mm;flex:none}.q svg{width:100%;height:100%}.t{display:flex;flex-direction:column;gap:1mm;font-size:9pt;line-height:1.25;min-width:0}.t b{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.p{font-size:11pt;font-weight:700}.c{color:#777;font-size:7pt;letter-spacing:.5px}@media screen{body{padding:12px}.g{max-width:100%}}</style></head><body><div class="g">${cells.join("")}</div></body></html>`;
  return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** 單一 QR 圖（公開：短碼本來就印在標籤上）：?c=<碼>&f=svg|png */
export async function handleQrImage(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  const sp = new URL(req.url).searchParams;
  const c = sp.get("c") ?? "";
  if (!QR_CODE_RE.test(c)) return new NextResponse("not found", { status: 404 });
  const tenant = await store.getTenantBySlug(slug);
  const q = tenant ? await store.getQrCodeByCode(tenant.id, c) : null;
  if (!tenant || !q) return new NextResponse("not found", { status: 404 });
  const url = qrShortUrl(baseUrlFrom(req), tenant, q.code);
  if (sp.get("f") === "png") return new NextResponse(new Uint8Array(await qrPng(url)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400", "content-disposition": `inline; filename="qr-${q.code}.png"` } });
  return new NextResponse(await qrSvg(url), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
