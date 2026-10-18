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
import { canViewOrder, orderPageUrl, sendOrderPlacedMails, shopSettingsSchema, type ShopSettings } from "./services/shop";
import { cancelOrderWithHooks, pchomepayClientFor, startOnlinePayment, type ProviderFactory } from "./services/orders";
import { GB_DEFAULT_RATE_PER_HOUR, placeGroupBuyOrder, reportPayerLast5 } from "./services/groupbuy";
import type { GroupBuySettings } from "@/modules/group-buy/manifest";
import { formPaymentMethod, onlinePaymentResponse } from "./pay-response";
import { isOnlineMethod } from "./pay/types";
import { formObject, memberTokenFromRequest, messageOf, originOk, siteRedirect } from "./site-request";
import { verifyPreviewToken } from "./preview";
import { cvsCookieName } from "./services/shipping";
import { cookieValue } from "./shop-routes";

/** 團購頁表單欄位 → 團購下單輸入（品項 qty_<團購品項 id>；運送 ship=pickup:<id>｜method:<id>） */
export function groupBuyOrderFromForm(f: Record<string, string>) {
  const items = Object.entries(f)
    .filter(([k, v]) => k.startsWith("qty_") && /^\d{1,2}$/.test(v.trim()) && Number(v) > 0)
    .map(([k, v]) => ({ itemId: k.slice(4), qty: Number(v) }));
  const ship = f.ship ?? "";
  const pickupPointId = ship.startsWith("pickup:") ? ship.slice(7) : undefined;
  const shippingMethodId = ship.startsWith("method:") ? ship.slice(7) : undefined;
  return {
    items,
    contact: { name: f.name ?? "", email: f.email ?? "", phone: f.phone ?? "" },
    shipping: { name: f.shipName?.trim() || f.name || "", phone: f.shipPhone?.trim() || f.phone || "", address: f.shipAddress ?? "" },
    note: f.note?.trim() ? f.note : undefined,
    paymentMethod: formPaymentMethod(f.paymentMethod) ?? f.paymentMethod ?? "",
    pchomepayType: f.paymentMethod === "pchomepay" && f.pchomepayType === "atm" ? ("atm" as const) : undefined,
    shippingMethodId,
    pickupPointId,
    cvsSelectionId: f.cvsSelectionId || undefined,
    couponCode: f.couponCode?.trim() || undefined,
    leaderCode: f.leader?.trim() || undefined,
    payerLast5: f.payerLast5?.trim() || undefined,
  };
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** 團購下單（表單 POST；免登入或會員）。限流每 IP 每小時（group-buy 設定 orderRateLimitPerHour，預設 20） */
export async function handleGroupBuyOrder(req: Request, rawSlug: string, store: Store = getStore(), clientFactory = pchomepayClientFor, providerFactory?: ProviderFactory): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const site = await loadSite(slug, null, store, { lang: null });
  if (!site || !moduleActive(site, "group-buy") || !moduleActive(site, "shop")) return new NextResponse("not found", { status: 404 });
  const { tenant } = site;
  const baseUrl = baseUrlFrom(req);
  let form: Record<string, string> = {};
  let back = "/";
  try {
    form = await formObject(req);
    const gbSlug = SLUG.test(form.groupBuy ?? "") ? form.groupBuy! : "";
    back = gbSlug ? `/groupbuy/${gbSlug}${form.leader ? `?leader=${encodeURIComponent(form.leader.slice(0, 16))}` : ""}` : "/";
    const gbs = moduleConfig<GroupBuySettings>(site, "group-buy");
    const hit = await store.rateHit(`groupbuy-order:${tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 3600, gbs.orderRateLimitPerHour ?? GB_DEFAULT_RATE_PER_HOUR);
    if (!hit.allowed) throw new ServiceError("rate_limited", "下單太頻繁，請稍後再試");
    const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
    const settings = (parsed.success ? parsed.data : {}) as ShopSettings;
    const member = (await getSessionMember(store, tenant, memberTokenFromRequest(req, tenant)))?.member ?? null;
    const allowSandbox = !!form.preview && verifyPreviewToken(form.preview, tenant.id, requireSecret("PREVIEW_SECRET")).ok;
    const { order, accessKey } = await placeGroupBuyOrder({ store, sendMail: getMailer(), baseUrl }, { tenant, member, slug: gbSlug, data: groupBuyOrderFromForm(form), allowSandbox, cvsBinding: cookieValue(req, cvsCookieName(tenant.id)) ?? null });
    if (isOnlineMethod(order.payment_method)) {
      try {
        const pay = await startOnlinePayment({ store, baseUrl, clientFactory, providerFactory }, { tenant, order, accessKey });
        await sendOrderPlacedMails({ store, sendMail: getMailer(), baseUrl }, tenant, order, settings, orderPageUrl(baseUrl, tenant, order.order_no, accessKey));
        return onlinePaymentResponse(pay);
      } catch (e) {
        await cancelOrderWithHooks({ store, sendMail: getMailer(), baseUrl }, tenant, order.id, ["pending_payment"], "payment_init_failed");
        throw e;
      }
    }
    return siteRedirect(req, slug, `/orders/${encodeURIComponent(order.order_no)}`, undefined, { k: accessKey, placed: "1" });
  } catch (e) {
    const [p, q] = back.split("?");
    const extra = Object.fromEntries(new URLSearchParams(q ?? ""));
    return siteRedirect(req, slug, p!, { err: messageOf(e) }, extra);
  }
}

/** 訂單頁「回報匯款帳號末五碼」（表單 POST；要有訂單存取金鑰或是下單會員本人） */
export async function handleReportTransfer(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) return new NextResponse("not found", { status: 404 });
  const f = await formObject(req).catch(() => ({}) as Record<string, string>);
  const orderNo = /^[A-Z0-9]{2,8}-\d{8}-\d{4,}$/.test(f.orderNo ?? "") ? f.orderNo! : "";
  const extra = f.k ? { k: f.k } : undefined;
  const path = `/orders/${encodeURIComponent(orderNo)}`;
  try {
    const hit = await store.rateHit(`groupbuy-report:${tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 3600, 20);
    if (!hit.allowed) throw new ServiceError("rate_limited", "送出太頻繁，請稍後再試");
    const order = orderNo ? await store.getOrderByNo(tenant.id, orderNo) : null;
    const member = (await getSessionMember(store, tenant, memberTokenFromRequest(req, tenant)))?.member ?? null;
    if (!order || !canViewOrder(order, f.k, member)) throw new ServiceError("not_found", "找不到訂單");
    await reportPayerLast5(store, tenant, order, f.payerLast5);
    return siteRedirect(req, slug, path, { ok: "已收到匯款帳號末五碼，店家核對後會標記付款" }, extra);
  } catch (e) {
    return siteRedirect(req, slug, orderNo ? path : "/", { err: messageOf(e) }, extra);
  }
}
