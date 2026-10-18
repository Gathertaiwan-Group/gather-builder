import { NextResponse } from "next/server";
import { getStore } from "./store";
import type { Store, TenantRow } from "./store/types";
import { requireSecret } from "./secrets";
import { getMailer } from "./mail";
import { baseUrlFrom } from "./runtime";
import { clientIp } from "./client-ip";
import { loadSite, moduleActive } from "./site-loader";
import { ServiceError } from "./errors";
import { hashIp } from "./services/inquiries";
import { getSessionMember } from "./services/members";
import { orderPageUrl, sendOrderPlacedMails, publishedShopSettings } from "./services/shop";
import { pchomepayClientFor, startPchomepayPayment } from "./services/orders";
import { formObject, memberTokenFromRequest, messageOf, originOk, siteRedirect } from "./site-request";
import { verifyPreviewToken } from "./preview";
import { cookieValue, referralCookieName } from "./shop-routes";
import { joinWaitlist, registerEvent } from "./services/events";
import type { OrderRow } from "./store/types";

/**
 * 活動／預約／課程的公開表單 POST（app/s/[site]/api/… 只轉呼叫這裡）：Origin 檢查、每 IP 限流、303 回頁面帶訊息。
 * 付費 → 走既有訂單＋付款（線下匯款 303 到訂單頁；PChomePay 303 到付款頁，建單失敗取消訂單＝同交易釋放名額）。
 */

export const CLASS_POST_LIMIT_PER_HOUR = 12;

export const contactFromForm = (f: Record<string, string>) => ({ name: f.name ?? "", email: f.email ?? "", phone: f.phone ?? "" });

async function siteFor(slug: string, moduleId: string, store: Store) {
  const site = await loadSite(slug, null, store);
  if (!site || !moduleActive(site, moduleId)) return null;
  return site;
}

async function guard(req: Request, slug: string, moduleId: string, store: Store, bucket: string) {
  if (!originOk(req)) return { res: new NextResponse("forbidden origin", { status: 403 }) } as const;
  const site = await siteFor(slug, moduleId, store);
  if (!site) return { res: new NextResponse("not found", { status: 404 }) } as const;
  const hit = await store.rateHit(`${bucket}:${site.tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 3600, CLASS_POST_LIMIT_PER_HOUR);
  if (!hit.allowed) throw new ServiceError("rate_limited", "送出太頻繁，請稍後再試");
  const form = await formObject(req);
  const member = (await getSessionMember(store, site.tenant, memberTokenFromRequest(req, site.tenant)))?.member ?? null;
  // H1：sandbox 金流只在帶有效預覽簽章時可用
  const allowSandbox = !!form.preview && verifyPreviewToken(form.preview, site.tenant.id, requireSecret("PREVIEW_SECRET")).ok;
  return { site, form, member, allowSandbox } as const;
}

/** 付費訂單建立後：線上付款 → 金流建單（失敗取消訂單、名額同交易釋放）；線下 → 訂單頁 */
export async function afterClassOrder(
  req: Request,
  store: Store,
  tenant: TenantRow,
  r: { order: OrderRow; accessKey: string },
  clientFactory = pchomepayClientFor,
): Promise<Response> {
  const baseUrl = baseUrlFrom(req);
  if (r.order.payment_method === "pchomepay") {
    try {
      const pay = await startPchomepayPayment({ store, baseUrl, clientFactory }, { tenant, order: r.order, accessKey: r.accessKey });
      await sendOrderPlacedMails({ store, sendMail: getMailer(), baseUrl }, tenant, r.order, await publishedShopSettings(store, tenant), orderPageUrl(baseUrl, tenant, r.order.order_no, r.accessKey));
      return NextResponse.redirect(pay.paymentUrl, 303);
    } catch (e) {
      await store.cancelOrder(tenant.id, r.order.id, ["pending_payment"], "payment_init_failed");
      throw e;
    }
  }
  return siteRedirect(req, tenant.slug, `/orders/${encodeURIComponent(r.order.order_no)}`, undefined, { k: r.accessKey, placed: "1" });
}

export async function handleEventRegister(req: Request, rawSlug: string, store: Store = getStore(), clientFactory = pchomepayClientFor): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  let back = "/events";
  try {
    const g = await guard(req, slug, "events", store, "event-register");
    if ("res" in g) return g.res!;
    const { site, form, member, allowSandbox } = g;
    const s = await store.getSession(site.tenant.id, form.sessionId ?? "");
    const ev = s ? await store.getEventById(site.tenant.id, s.event_id) : null;
    if (ev) back = `/events/${ev.slug}`;
    const r = await registerEvent(
      { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      {
        tenant: site.tenant,
        member,
        allowSandbox,
        data: {
          sessionId: form.sessionId,
          ticketTypeId: form.ticketTypeId,
          qty: form.qty || "1",
          contact: contactFromForm(form),
          paymentMethod: form.paymentMethod === "pchomepay" ? "pchomepay" : form.paymentMethod === "offline" ? "offline" : undefined,
          couponCode: form.couponCode?.trim() || undefined,
          // 推薦碼只從 cookie 讀（同結帳）
          referralCode: cookieValue(req, referralCookieName(site.tenant.id)) || undefined,
          offerId: form.offerId || undefined,
          offerToken: form.offerToken || undefined,
        },
      },
    );
    if (r.kind === "free") return siteRedirect(req, slug, back, { ok: `報名成功！確認信已寄到 ${r.registration.contact.email}（簽到碼 ${r.checkinCode}）` });
    return afterClassOrder(req, store, site.tenant, r, clientFactory);
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}

export async function handleEventWaitlist(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  let back = "/events";
  try {
    const g = await guard(req, slug, "events", store, "event-waitlist");
    if ("res" in g) return g.res!;
    const { site, form, member } = g;
    const s = await store.getSession(site.tenant.id, form.sessionId ?? "");
    const ev = s ? await store.getEventById(site.tenant.id, s.event_id) : null;
    if (ev) back = `/events/${ev.slug}`;
    const r = await joinWaitlist({ store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenant: site.tenant, member, data: { sessionId: form.sessionId, ticketTypeId: form.ticketTypeId, qty: form.qty || "1", contact: contactFromForm(form) } });
    return siteRedirect(req, slug, back, { ok: r.position > 0 ? `已登記候補（目前第 ${r.position} 位）。有名額時會寄信通知你。` : "剛好有名額釋出，已寄出遞補通知信，請到信箱點連結完成報名。" });
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}
