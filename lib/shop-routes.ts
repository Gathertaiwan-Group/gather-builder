import { NextResponse } from "next/server";
import { getStore } from "./store";
import type { Store } from "./store/types";
import { requireSecret } from "./secrets";
import { getMailer } from "./mail";
import { baseUrlFrom } from "./runtime";
import { clientIp } from "./client-ip";
import { loadSite, moduleActive, moduleConfig } from "./site-loader";
import { ServiceError } from "./errors";
import { hashIp } from "./services/inquiries";
import { getSessionMember } from "./services/members";
import { flatShippingFee, orderPageUrl, placeOrder, priceCart, sendOrderPlacedMails, shopSettingsSchema, type ShopSettings } from "./services/shop";
import { cancelOrderWithHooks, pchomepayClientFor, startPchomepayPayment } from "./services/orders";
import { formObject, memberTokenFromRequest, messageOf, originOk, siteRedirect } from "./site-request";
import { json } from "./http";
import { guardJsonPost } from "./public-post";
import { verifyPreviewToken } from "./preview";
import { invoiceRequestFromForm } from "./invoice/validate";
import { cvsCookieName, resolveShipping } from "./services/shipping";
import { applyPromotions } from "./services/promotions";
import { resolveCredits } from "./services/credits";

export const referralCookieName = (tenantId: string) => `gbref_${tenantId.replace(/-/g, "").slice(0, 12)}`;

/** 讀 request 的某個 cookie（不解碼以外的處理） */
export function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** M1：每 IP 每小時下單上限（原 20，降低以減少庫存凍結） */
export const CHECKOUT_LIMIT_PER_HOUR = 6;
/** L-4：試算每 IP 每 10 分鐘上限（原 120；折扣碼試算不可當猜碼神諭） */
export const QUOTE_LIMIT_PER_10MIN = 40;
/** L-4：試算時折扣碼無效或條件不符一律回同一句（細節只在真正下單時才回） */
export const QUOTE_COUPON_REJECTED = "折扣碼無法使用（請確認代碼、使用期間與條件）";

async function shopSite(slug: string, store: Store) {
  const site = await loadSite(slug.toLowerCase(), null, store);
  if (!site || !moduleActive(site, "shop")) return null;
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  return { site, settings: (parsed.success ? parsed.data : {}) as ShopSettings };
}

/** 購物車／結帳頁用：依 DB 重新計價（前端只送商品 id 與數量） */
export async function handleQuote(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const blocked = guardJsonPost(req, 20_000);
  if (blocked) return blocked;
  try {
    const s = await shopSite(rawSlug, store);
    if (!s) return json({ error: "找不到商店" }, 404);
    const hit = await store.rateHit(`shop-quote:${s.site.tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 600, QUOTE_LIMIT_PER_10MIN);
    if (!hit.allowed) return json({ error: "請求太頻繁" }, 429);
    const body = (await req.json().catch(() => null)) as { items?: unknown; shippingMethodId?: unknown; couponCode?: unknown; email?: unknown; preview?: unknown; pointsToUse?: unknown; walletToUse?: unknown } | null;
    const priced = await priceCart(store, s.site.tenant.id, body?.items, s.settings);
    const tenant = s.site.tenant;
    const allowStage = typeof body?.preview === "string" && verifyPreviewToken(body.preview, tenant.id, requireSecret("PREVIEW_SECRET")).ok;
    const member = (await getSessionMember(store, tenant, memberTokenFromRequest(req, tenant)))?.member ?? null;
    const promo = await applyPromotions(store, tenant, {
      subtotal: priced.subtotal,
      couponCode: typeof body?.couponCode === "string" ? body.couponCode.slice(0, 32) : null,
      member,
      email: typeof body?.email === "string" ? body.email.slice(0, 200).toLowerCase() : (member?.email ?? ""),
      strict: false,
    });
    // M-2：免運門檻用折扣後金額（與下單同一套）
    const ship = await resolveShipping(store, tenant, { methodId: typeof body?.shippingMethodId === "string" ? body.shippingMethodId : null, subtotal: priced.subtotal - promo.discount, consume: false, allowStage });
    const shippingFee = ship ? ship.fee : flatShippingFee(s.settings, priced.subtotal - promo.discount, priced.lines.length > 0);
    const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, 10_000_000) : 0);
    const credits = await resolveCredits(store, tenant, { member, merchandise: priced.subtotal - promo.discount, shippingFee, pointsToUse: num(body?.pointsToUse), walletToUse: num(body?.walletToUse), strict: false });
    return json({
      lines: priced.lines.map((l) => ({ productId: l.product_id, variantId: l.variant_id, name: l.name, variantLabel: l.variant_label, unitPrice: l.unit_price, qty: l.qty, lineTotal: l.line_total, lowStock: l.stockAvailable !== null && l.stockAvailable <= 5, slug: l.slug })),
      subtotal: priced.subtotal,
      shippingFee,
      shippingSelected: ship ? !!ship.choice.methodId : true,
      discount: promo.discount,
      couponMessage: promo.coupon ? promo.couponMessage : promo.couponMessage ? QUOTE_COUPON_REJECTED : null,
      tierName: credits.tierName,
      tierDiscount: credits.tierDiscount,
      pointsRedeemed: credits.pointsRedeemed,
      pointsDiscount: credits.pointsDiscount,
      pointsAvailable: credits.pointsAvailable,
      maxPoints: credits.maxPoints,
      pointValue: credits.pointValue,
      walletPaid: credits.walletPaid,
      walletAvailable: credits.walletAvailable,
      creditMessages: credits.messages,
      total: credits.total,
      problems: priced.problems,
    });
  } catch (e) {
    if (e instanceof ServiceError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "伺服器錯誤" }, 500);
  }
}

/** 表單欄位 → 結帳輸入（items 為 JSON 字串） */
export function checkoutFromForm(f: Record<string, string>) {
  let items: unknown = null;
  try {
    items = JSON.parse(f.items ?? "null");
  } catch {
    items = null;
  }
  const same = f.shipSame === "on" || f.shipSame === "1";
  return {
    items,
    contact: { name: f.contactName ?? "", email: f.contactEmail ?? "", phone: f.contactPhone ?? "" },
    shipping: {
      name: same ? (f.contactName ?? "") : (f.shipName ?? ""),
      phone: same ? (f.contactPhone ?? "") : (f.shipPhone ?? ""),
      address: f.shipAddress ?? "",
    },
    note: f.note?.trim() ? f.note : undefined,
    paymentMethod: f.paymentMethod,
    pchomepayType: f.paymentMethod === "pchomepay" && f.pchomepayType === "atm" ? ("atm" as const) : undefined,
    invoice: f.invoiceType ? invoiceRequestFromForm(f) : undefined,
    shippingMethodId: f.shippingMethodId || undefined,
    cvsSelectionId: f.cvsSelectionId || undefined,
    couponCode: f.couponCode?.trim() || undefined,
    referralCode: f.referralCode?.trim() || undefined,
    pointsToUse: intField(f.pointsToUse),
    walletToUse: intField(f.walletToUse),
  };
}

/** 表單數字欄位：空字串／0 → undefined；非整數 → NaN（交給 zod 回錯） */
function intField(v: string | undefined): number | undefined {
  if (!v || !v.trim() || v.trim() === "0") return undefined;
  return /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
}

export async function handleCheckout(req: Request, rawSlug: string, store: Store = getStore(), clientFactory = pchomepayClientFor): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const s = await shopSite(slug, store);
  if (!s) return new NextResponse("not found", { status: 404 });
  const { tenant } = s.site;
  const baseUrl = baseUrlFrom(req);
  try {
    const hit = await store.rateHit(`checkout:${tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 3600, CHECKOUT_LIMIT_PER_HOUR);
    if (!hit.allowed) throw new ServiceError("rate_limited", "下單太頻繁，請稍後再試");
    const form = await formObject(req);
    const member = (await getSessionMember(store, tenant, memberTokenFromRequest(req, tenant)))?.member ?? null;
    // H1：只有帶「有效預覽簽章」的結帳才可以用 sandbox 憑證（網站主自己測試用）
    const allowSandbox = !!form.preview && verifyPreviewToken(form.preview, tenant.id, requireSecret("PREVIEW_SECRET")).ok;
    const data = checkoutFromForm(form);
    // 推薦碼只從 cookie 讀（分享連結 ?ref= 設的），表單欄位一律不採信
    data.referralCode = cookieValue(req, referralCookieName(tenant.id)) || undefined;
    const cvsBinding = cookieValue(req, cvsCookieName(tenant.id)) ?? null;
    const { order, accessKey } = await placeOrder({ store, sendMail: getMailer(), baseUrl }, { tenant, member, data, settings: s.settings, allowSandbox, cvsBinding });
    if (order.payment_method === "pchomepay") {
      try {
        const pay = await startPchomepayPayment({ store, baseUrl, clientFactory }, { tenant, order, accessKey });
        await sendOrderPlacedMails({ store, sendMail: getMailer(), baseUrl }, tenant, order, s.settings, orderPageUrl(baseUrl, tenant, order.order_no, accessKey));
        return NextResponse.redirect(pay.paymentUrl, 303);
      } catch (e) {
        // 金流建單失敗：取消訂單並回補庫存，讓客人重新結帳
        await cancelOrderWithHooks({ store, sendMail: getMailer(), baseUrl }, tenant, order.id, ["pending_payment"], "payment_init_failed");
        throw e;
      }
    }
    return siteRedirect(req, slug, `/orders/${encodeURIComponent(order.order_no)}`, undefined, { k: accessKey, placed: "1" });
  } catch (e) {
    return siteRedirect(req, slug, "/checkout", { err: messageOf(e) });
  }
}
