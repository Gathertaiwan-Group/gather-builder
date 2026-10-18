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
import { orderPageUrl, placeOrder, priceCart, sendOrderPlacedMails, shopSettingsSchema, type ShopSettings } from "./services/shop";
import { pchomepayClientFor, startPchomepayPayment } from "./services/orders";
import { formObject, memberTokenFromRequest, messageOf, originOk, siteRedirect } from "./site-request";
import { json } from "./http";
import { verifyPreviewToken } from "./preview";

/** M1：每 IP 每小時下單上限（原 20，降低以減少庫存凍結） */
export const CHECKOUT_LIMIT_PER_HOUR = 6;
export const QUOTE_LIMIT_PER_10MIN = 120;

async function shopSite(slug: string, store: Store) {
  const site = await loadSite(slug.toLowerCase(), null, store);
  if (!site || !moduleActive(site, "shop")) return null;
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  return { site, settings: (parsed.success ? parsed.data : {}) as ShopSettings };
}

/** 購物車／結帳頁用：依 DB 重新計價（前端只送商品 id 與數量） */
export async function handleQuote(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  try {
    const s = await shopSite(rawSlug, store);
    if (!s) return json({ error: "找不到商店" }, 404);
    const hit = await store.rateHit(`shop-quote:${s.site.tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 600, QUOTE_LIMIT_PER_10MIN);
    if (!hit.allowed) return json({ error: "請求太頻繁" }, 429);
    const body = (await req.json().catch(() => null)) as { items?: unknown } | null;
    const priced = await priceCart(store, s.site.tenant.id, body?.items, s.settings);
    return json({
      lines: priced.lines.map((l) => ({ productId: l.product_id, variantId: l.variant_id, name: l.name, variantLabel: l.variant_label, unitPrice: l.unit_price, qty: l.qty, lineTotal: l.line_total, lowStock: l.stockAvailable !== null && l.stockAvailable <= 5, slug: l.slug })),
      subtotal: priced.subtotal,
      shippingFee: priced.shippingFee,
      total: priced.total,
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
  };
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
    const { order, accessKey } = await placeOrder({ store, sendMail: getMailer(), baseUrl }, { tenant, member, data: checkoutFromForm(form), settings: s.settings, allowSandbox });
    if (order.payment_method === "pchomepay") {
      try {
        const pay = await startPchomepayPayment({ store, baseUrl, clientFactory }, { tenant, order, accessKey });
        await sendOrderPlacedMails({ store, sendMail: getMailer(), baseUrl }, tenant, order, s.settings, orderPageUrl(baseUrl, tenant, order.order_no, accessKey));
        return NextResponse.redirect(pay.paymentUrl, 303);
      } catch (e) {
        // 金流建單失敗：取消訂單並回補庫存，讓客人重新結帳
        await store.cancelOrder(tenant.id, order.id, ["pending_payment"], "payment_init_failed");
        throw e;
      }
    }
    return siteRedirect(req, slug, `/orders/${encodeURIComponent(order.order_no)}`, undefined, { k: accessKey, placed: "1" });
  } catch (e) {
    return siteRedirect(req, slug, "/checkout", { err: messageOf(e) });
  }
}
