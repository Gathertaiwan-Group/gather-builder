import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { QrCatalogSettings } from "@/modules/qr-catalog/manifest";
import type { OrderRow, ProductRow, QrCodeRow, Store, TenantRow } from "../store/types";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, publishedShopSettings, twd } from "./shop";
import { signFor, verifySigned } from "./class-orders";
import { qrSvg } from "../qr";
import { DEFAULT_LANG, isLangCode } from "../i18n/langs";
import type { Mailer } from "../mail";

/* ================================================================== 共用 */

export const QR_CODE_RE = /^[A-Za-z0-9]{10}$/;
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 落地頁支援自動切換的語言（第一版：中、英、日） */
export const QR_LANGS = ["zh-TW", "en", "ja"] as const;
export const SCAN_COOKIE_MAX = 10;
export const SCAN_ATTRIBUTION_DAYS = 30;

/** 10 字隨機英數（拒絕取樣，沒有模數偏差；約 59 bits，不可預測） */
export function genQrCode(): string {
  let s = "";
  while (s.length < 10) {
    for (const b of randomBytes(16)) {
      if (b < 248) s += B62[b % 62];
      if (s.length === 10) break;
    }
  }
  return s;
}

export async function qrActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("qr-catalog");
}
async function requireQr(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await qrActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「qr-catalog」，請先 enable_module qr-catalog");
}
export async function publishedQrSettings(store: Store, tenant: TenantRow): Promise<QrCatalogSettings> {
  return (await publishedModuleSettings(store, tenant, "qr-catalog")) as QrCatalogSettings;
}

export function qrShortUrl(baseUrl: string, tenant: Pick<TenantRow, "slug">, code: string) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/q/${code}`;
}

function secret(): string {
  const v = process.env.PREVIEW_SECRET;
  if (!v || v.length < 8) throw new Error("環境變數 PREVIEW_SECRET 未設定或太短");
  return v;
}
const hmac = (s: string) => createHmac("sha256", secret()).update(s).digest("base64url").slice(0, 32);
function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/* ================================================================== 語言與國家 */

/**
 * 依 Accept-Language 選落地頁語言（純函式）：照 q 值排序，只接受 available 裡的（＝網站有開、且這個商品有該語言的已發布翻譯；zh-TW 一定有）。
 * zh／zh-TW／zh-Hant／zh-HK 視為繁中；都沒有就 zh-TW。
 */
export function pickLang(acceptLanguage: string | null | undefined, available: readonly string[]): string {
  const list = (acceptLanguage ?? "")
    .split(",")
    .slice(0, 20)
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^q=([0-9.]+)$/.exec(p.trim())).find(Boolean);
      return { tag: (tag ?? "").trim().toLowerCase(), q: q ? Number(q[1]) : 1, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of list) {
    const primary = tag.split("-")[0]!;
    const cand = primary === "zh" ? (/^zh-(cn|sg|hans)/.test(tag) ? "zh-cn" : DEFAULT_LANG) : primary;
    if (available.includes(cand)) return cand;
  }
  return DEFAULT_LANG;
}

/** 國家碼只來自 Vercel 的 geo header（x-vercel-ip-country，兩碼大寫）；其他值或缺 → null。🔴 不讀、不存 IP */
export function countryFromHeaders(h: Headers): string | null {
  const v = (h.get("x-vercel-ip-country") ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) && v !== "XX" ? v : null;
}

/* ================================================================== 掃描 cookie（歸因：掃碼後的線上訂單／詢價） */

export const scanCookieName = (tenantId: string) => `gbqr_${tenantId.replace(/-/g, "").slice(0, 12)}`;

/** 最近 10 次掃描 id，HMAC 簽章（瀏覽器改不了別人的掃描 id） */
export function signScanCookie(tenantId: string, ids: number[]): string {
  const v = ids.slice(-SCAN_COOKIE_MAX).join(".");
  return `${v}~${hmac(`qrscan:${tenantId}:${v}`)}`;
}
export function readScanCookie(tenantId: string, raw: string | null | undefined): number[] {
  if (!raw || raw.length > 400) return [];
  const [v, sig] = raw.split("~");
  if (!v || !sig || !safeEq(hmac(`qrscan:${tenantId}:${v}`), sig)) return [];
  return v.split(".").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(-SCAN_COOKIE_MAX);
}

/* ================================================================== 產生 QR 與標籤 */

async function codeFor(store: Store, tenant: TenantRow, productId: string): Promise<QrCodeRow> {
  const have = await store.getQrCodeByProduct(tenant.id, productId);
  if (have) return have;
  for (let i = 0; i < 5; i++) {
    const row = await store.insertQrCode({ tenant_id: tenant.id, product_id: productId, code: genQrCode() });
    if (row) return row;
    const again = await store.getQrCodeByProduct(tenant.id, productId); // 併發時另一個請求先建好
    if (again) return again;
  }
  throw new Error("無法產生 QR 短碼");
}

/** 標籤頁簽章網址（1 小時有效）：/api/s/<slug>/qr/labels?c=<碼,碼>&exp=<秒>&t=<HMAC> */
export function labelsUrl(baseUrl: string, tenant: Pick<TenantRow, "id" | "slug">, codes: string[], nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + 3600;
  const c = codes.join(",");
  return `${baseUrl.replace(/\/$/, "")}/api/s/${tenant.slug}/qr/labels?c=${c}&exp=${exp}&t=${hmac(`qrlabels:${tenant.id}:${c}:${exp}`)}`;
}
export function verifyLabelsUrl(tenant: Pick<TenantRow, "id">, c: string, exp: string, t: string, nowMs = Date.now()): string[] | null {
  if (!/^[A-Za-z0-9,]{10,1200}$/.test(c) || !/^\d{9,12}$/.test(exp) || Number(exp) * 1000 < nowMs) return null;
  if (!safeEq(hmac(`qrlabels:${tenant.id}:${c}:${exp}`), t ?? "")) return null;
  const codes = c.split(",").filter((x) => QR_CODE_RE.test(x));
  return codes.length ? codes.slice(0, 120) : null;
}

/**
 * 產生 QR（commerce:write）：每個已上架商品一組短碼（已有就沿用），回傳短連結、SVG（includeSvg，預設 true）與 A4 標籤頁網址（1 小時有效）。
 * 不帶 productIds＝全部已上架商品（最多 120 個）。
 */
export async function generateQrLabels(ctx: ServiceContext, input: { site?: string | null; productIds?: string[]; brand?: string; includeSvg?: boolean }) {
  requireScope(ctx, "commerce:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireQr(ctx, tenant);
  let products: ProductRow[];
  if (input.productIds?.length) {
    products = await ctx.store.getProductsByIds(tenant.id, [...new Set(input.productIds)].slice(0, 120));
    const missing = input.productIds.filter((id) => !products.some((p) => p.id === id));
    if (missing.length) throw new ServiceError("not_found", `找不到商品：${missing.slice(0, 5).join(", ")}`);
  } else {
    products = (await ctx.store.listProducts(tenant.id, { status: "published", limit: 120, offset: 0 })).rows;
  }
  if (input.brand) products = products.filter((p) => p.brand === input.brand);
  const drafts = products.filter((p) => p.status !== "published");
  if (drafts.length) throw new ServiceError("invalid", `商品尚未上架，不能產生 QR：${drafts.map((p) => p.name).slice(0, 5).join("、")}`);
  if (!products.length) throw new ServiceError("invalid", "沒有可產生 QR 的已上架商品");
  const labels = [];
  for (const p of products) {
    const qr = await codeFor(ctx.store, tenant, p.id);
    const url = qrShortUrl(ctx.baseUrl, tenant, qr.code);
    labels.push({ productId: p.id, name: p.name, price: p.price, brand: p.brand ?? null, code: qr.code, url, pngUrl: `${ctx.baseUrl.replace(/\/$/, "")}/api/s/${tenant.slug}/qr/img?c=${qr.code}&f=png`, ...(input.includeSvg !== false ? { svg: await qrSvg(url) } : {}) });
  }
  await audit(ctx, tenant.id, "qr.labels", { count: labels.length });
  return { labels, labelsUrl: labelsUrl(ctx.baseUrl, tenant, labels.map((l) => l.code)), note: "labelsUrl 是 A4 標籤頁（一頁 21 張：商品名、價格、QR），1 小時內有效，用瀏覽器開啟後列印。短碼不會變，重印同一個商品會是同一組 QR。" };
}

/* ================================================================== 掃描（公開） */

/** 商品有哪些語言可以自動切換（網站有開＋該商品名稱有已發布翻譯；預覽不算） */
export async function availableLangsFor(store: Store, tenant: TenantRow, enabled: string[], productId: string): Promise<string[]> {
  const out: string[] = [DEFAULT_LANG];
  for (const l of QR_LANGS) {
    if (l === DEFAULT_LANG || !enabled.includes(l)) continue;
    const tr = await store.listTranslations(tenant.id, { lang: l, entityType: "product", entityIds: [productId] });
    if (tr.some((t) => t.field === "name" && !!t.published_value)) out.push(l);
  }
  return out;
}

/**
 * 記錄一次掃描（只增不改）：🔴 不存 IP（只用 IP 雜湊做限流，不寫進掃描紀錄）、不存 UA；國家碼只來自 Vercel geo header（可缺）。
 * 回傳要導去的語言與掃描 id（被限流時不記錄、scanId null，頁面照常顯示）。
 */
export async function recordScan(store: Store, tenant: TenantRow, input: { code: string; acceptLanguage: string | null; headers: Headers; ipHash: string; enabledLangs: string[] }) {
  if (!QR_CODE_RE.test(input.code)) return null;
  const qr = await store.getQrCodeByCode(tenant.id, input.code);
  if (!qr || qr.status !== "active") return null;
  const product = await store.getProductById(tenant.id, qr.product_id);
  if (!product || product.status !== "published") return null;
  const langs = await availableLangsFor(store, tenant, input.enabledLangs, product.id);
  const lang = pickLang(input.acceptLanguage, langs);
  const settings = await publishedQrSettings(store, tenant);
  const hit = await store.rateHit(`qr-scan:${tenant.id}`, input.ipHash, 600, settings.scanLogLimitPer10Min ?? 60);
  const scan = hit.allowed ? await store.insertQrScan({ tenant_id: tenant.id, qr_id: qr.id, product_id: product.id, lang, country: countryFromHeaders(input.headers) }) : null;
  return { qr, product, lang, scanId: scan?.id ?? null };
}

/** 掃碼後的線上訂單 → 轉換（只記這張訂單裡、掃描過的商品；每張訂單×商品一次；30 天內的掃描才算） */
export async function recordOrderConversions(store: Store, tenant: TenantRow, order: Pick<OrderRow, "id" | "items">, scanIds: number[]) {
  if (!scanIds.length || !(await qrActive(store, tenant.id))) return 0;
  const scans = (await store.listQrScansByIds(tenant.id, scanIds)).filter((s) => Date.parse(s.scanned_at) > Date.now() - SCAN_ATTRIBUTION_DAYS * 86400_000);
  let n = 0;
  for (const pid of new Set(order.items.map((i) => i.product_id).filter((x): x is string => !!x))) {
    const s = scans.filter((x) => x.product_id === pid).sort((a, b) => b.id - a.id)[0];
    if (s && (await store.insertQrConversion({ tenant_id: tenant.id, scan_id: s.id, product_id: pid, kind: "order", ref_id: order.id }))) n++;
  }
  return n;
}

export const overseasInquiryInput = z
  .object({
    code: z.string().regex(QR_CODE_RE),
    lang: z.string().max(10).optional(),
    name: z.string().trim().min(1, "請填寫姓名").max(80),
    email: z.email({ message: "Email 格式不正確" }).max(200),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, { message: "國家請選擇（兩碼）" }),
    address: z.string().trim().min(5, "請填寫寄送地址").max(500),
    message: z.string().trim().max(2000).optional(),
    /** honeypot */
    website: z.string().max(200).optional(),
  })
  .strict();

/**
 * 海外寄送詢價（公開表單）：寫進既有 inquiries（店主報價）＋記一筆詢價轉換（同瀏覽器掃過這個商品才算）＋通知店主。
 * 第一版不做跨境物流整合。每 IP 每小時 5 筆。
 */
export async function submitOverseasInquiry(deps: { store: Store; sendMail?: Mailer }, input: { tenant: TenantRow; data: unknown; scanIds: number[]; ipHash: string }) {
  const { tenant } = input;
  if (!(await qrActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放");
  const d = parse(overseasInquiryInput, input.data);
  if (d.website?.trim()) return { stored: false };
  const qr = await deps.store.getQrCodeByCode(tenant.id, d.code);
  const product = qr ? await deps.store.getProductById(tenant.id, qr.product_id) : null;
  if (!qr || !product) throw new ServiceError("not_found", "找不到商品");
  const hit = await deps.store.rateHit(`qr-inquiry:${tenant.id}`, input.ipHash, 3600, 5);
  if (!hit.allowed) throw new ServiceError("rate_limited", "送出太頻繁，請稍後再試");
  const lang = d.lang && (d.lang === DEFAULT_LANG || isLangCode(d.lang)) ? d.lang : DEFAULT_LANG;
  const inq = await deps.store.insertInquiry({
    tenant_id: tenant.id,
    name: d.name,
    email: d.email,
    phone: null,
    message: `［海外寄送詢價］\n商品：${product.name}（NT$${product.price}）\n寄送國家：${d.country}\n地址：${d.address}\n語言：${lang}${d.message ? `\n留言：${d.message}` : ""}`,
    source_path: `/q/${qr.code}`,
    ip_hash: input.ipHash,
  });
  const scans = (await deps.store.listQrScansByIds(tenant.id, input.scanIds)).filter((s) => s.product_id === product.id).sort((a, b) => b.id - a.id);
  if (scans[0]) await deps.store.insertQrConversion({ tenant_id: tenant.id, scan_id: scans[0].id, product_id: product.id, kind: "inquiry", ref_id: inq.id });
  const settings = await publishedQrSettings(deps.store, tenant);
  const owner = settings.ownerEmail ?? (await publishedShopSettings(deps.store, tenant)).ownerEmail;
  if (owner) await mailSafe(deps, owner, `【${tenant.name}】海外寄送詢價：${product.name}（${d.country}）`, `${d.name}（${d.email}）想把「${product.name}」寄到 ${d.country}：\n${d.address}\n${d.message ? `\n留言：${d.message}\n` : ""}\n請回信報價（含國際運費）。`);
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "guest", action: "qr.inquiry", payload: { code: qr.code, country: d.country, attributed: !!scans[0] } });
  return { stored: true };
}

/* ================================================================== 報表 */

async function reportRows(store: Store, tenant: TenantRow, sinceIso: string, productIds?: string[] | null) {
  const rows = await store.qrScanReport(tenant.id, sinceIso, productIds);
  const products = await store.getProductsByIds(tenant.id, [...new Set(rows.map((r) => r.product_id))]);
  return rows
    .map((r) => {
      const p = products.find((x) => x.id === r.product_id);
      const conv = r.orders + r.inquiries;
      return { productId: r.product_id, product: p?.name ?? "（已刪除）", brand: p?.brand ?? null, country: r.country || null, lang: r.lang, scans: r.scans, orders: r.orders, inquiries: r.inquiries, conversionRate: r.scans ? Math.round((conv / r.scans) * 1000) / 10 : 0 };
    })
    .sort((a, b) => b.scans - a.scans);
}

/** 掃描報表（orders:read）：商品 × 國家 × 語言的掃描數、轉成線上訂單／詢價的數量與轉換率（%）。這是給品牌看的「出海資料」 */
export async function getScanReport(ctx: ServiceContext, input: { site?: string | null; sinceDays?: number; brand?: string }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireQr(ctx, tenant);
  const days = Math.max(1, Math.min(730, input.sinceDays ?? 90));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let rows = await reportRows(ctx.store, tenant, since);
  if (input.brand) rows = rows.filter((r) => r.brand === input.brand);
  const byCountry = new Map<string, { scans: number; conversions: number }>();
  for (const r of rows) {
    const k = r.country ?? "??";
    const b = byCountry.get(k) ?? { scans: 0, conversions: 0 };
    b.scans += r.scans;
    b.conversions += r.orders + r.inquiries;
    byCountry.set(k, b);
  }
  return {
    sinceDays: days,
    rows,
    byCountry: [...byCountry.entries()].map(([country, v]) => ({ country: country === "??" ? null : country, ...v })).sort((a, b) => b.scans - a.scans),
    note: "國家碼來自 Vercel 依連線 IP 推測（不存 IP）；null＝無法判斷。轉換＝同一瀏覽器掃碼後 30 天內的線上訂單（含該商品）或海外寄送詢價。",
  };
}

/* ================================================================== 品牌報表連結（簽章、可撤銷、到期；不含個資） */

export function brandReportToken(id: string) {
  return `${id}.${signFor("brandreport", id)}`;
}
export function brandReportUrl(baseUrl: string, tenant: Pick<TenantRow, "slug">, id: string) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/brand-report/${brandReportToken(id)}`;
}

export async function createBrandReportLink(ctx: ServiceContext, input: { site?: string | null; brand: string; label?: string; expiresInDays?: number; confirm?: boolean }) {
  requireScope(ctx, "marketing:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireQr(ctx, tenant);
  const brand = parse(z.string().trim().min(1).max(80), input.brand);
  const days = input.expiresInDays ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new ServiceError("invalid", "expiresInDays 需為 1–365");
  const products = (await ctx.store.listProducts(tenant.id, { limit: 500, offset: 0 })).rows.filter((p) => p.brand === brand);
  if (!products.length) throw new ServiceError("not_found", `沒有品牌為「${brand}」的商品（用 update_product 設定 brand）`);
  if (input.confirm !== true) throw new ServiceError("confirm_required", `建立「${brand}」的唯讀報表連結（${products.length} 個商品的掃描與銷售統計，不含顧客資料），${days} 天後到期；拿到連結的人都看得到。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const row = await ctx.store.insertBrandReportLink({ tenant_id: tenant.id, brand, label: input.label?.trim().slice(0, 80) || null, expires_at: new Date(Date.now() + days * 86400_000).toISOString(), created_by: ctx.actor.label });
  await audit(ctx, tenant.id, "qr.brand_link", { linkId: row.id, brand, days });
  return { linkId: row.id, brand, expiresAt: row.expires_at, url: brandReportUrl(ctx.baseUrl, tenant, row.id), note: "可用 revoke_brand_report_link 立即撤銷。" };
}

export async function revokeBrandReportLink(ctx: ServiceContext, input: { site?: string | null; linkId: string }) {
  requireScope(ctx, "marketing:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireQr(ctx, tenant);
  const l = await ctx.store.getBrandReportLink(tenant.id, input.linkId);
  if (!l) throw new ServiceError("not_found", "找不到這個報表連結");
  const revoked = await ctx.store.revokeBrandReportLink(tenant.id, l.id);
  await audit(ctx, tenant.id, "qr.brand_link_revoke", { linkId: l.id });
  return { linkId: l.id, revoked: revoked || !!l.revoked_at };
}

export async function listBrandReportLinks(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "marketing:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireQr(ctx, tenant);
  return { links: (await ctx.store.listBrandReportLinks(tenant.id)).map((l) => ({ linkId: l.id, brand: l.brand, label: l.label, expiresAt: l.expires_at, revokedAt: l.revoked_at, active: !l.revoked_at && Date.parse(l.expires_at) > Date.now() })) };
}

/** 品牌報表（公開唯讀；token＝<連結 id>.<HMAC>）：撤銷／到期／簽章錯一律 null。🔴 只有統計數字，沒有任何顧客資料 */
export async function brandReport(store: Store, tenant: TenantRow, token: string | null | undefined, sinceDays = 90) {
  const [id, sig] = (token ?? "").split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/i.test(id) || !verifySigned("brandreport", id, sig)) return null;
  const link = await store.getBrandReportLink(tenant.id, id);
  if (!link || link.revoked_at || Date.parse(link.expires_at) <= Date.now()) return null;
  // 第八批審查 L-4：只列已上架商品（草稿／下架商品不出現在給品牌看的報表）
  const products = (await store.listProducts(tenant.id, { status: "published", limit: 500, offset: 0 })).rows.filter((p) => p.brand === link.brand);
  const ids = products.map((p) => p.id);
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const [scan, sales] = await Promise.all([ids.length ? reportRows(store, tenant, since, ids) : Promise.resolve([]), ids.length ? store.brandSales(tenant.id, ids, since) : Promise.resolve([])]);
  return {
    brand: link.brand,
    label: link.label,
    expiresAt: link.expires_at,
    sinceDays,
    products: products.map((p) => {
      const s = sales.find((x) => x.product_id === p.id);
      const rows = scan.filter((r) => r.productId === p.id);
      return {
        name: p.name,
        price: p.price,
        priceText: twd(p.price),
        scans: rows.reduce((a, r) => a + r.scans, 0),
        conversions: rows.reduce((a, r) => a + r.orders + r.inquiries, 0),
        soldQty: s?.qty ?? 0,
        revenue: s?.revenue ?? 0,
        paidOrders: s?.orders ?? 0,
        byCountryLang: rows.map((r) => ({ country: r.country, lang: r.lang, scans: r.scans, orders: r.orders, inquiries: r.inquiries })),
      };
    }),
  };
}
