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
import { cancelOrderWithHooks, pchomepayClientFor, startOnlinePayment, type ProviderFactory } from "./services/orders";
import { formPaymentMethod, onlinePaymentResponse } from "./pay-response";
import { isOnlineMethod } from "./pay/types";
import { formObject, memberTokenFromRequest, messageOf, originOk, siteRedirect } from "./site-request";
import { verifyPreviewToken } from "./preview";
import { cookieValue, referralCookieName } from "./shop-routes";
import { confirmEventEmail, joinWaitlist, registerEvent } from "./services/events";
import { bookSlot, selfCancelBooking, selfRescheduleBooking } from "./services/booking";
import { buyCourse, markLessonComplete } from "./services/courses";
import { buyTopup } from "./services/wallet";
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

export async function guard(req: Request, slug: string, moduleId: string, store: Store, bucket: string) {
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
  providerFactory?: ProviderFactory,
): Promise<Response> {
  const baseUrl = baseUrlFrom(req);
  if (isOnlineMethod(r.order.payment_method)) {
    try {
      const pay = await startOnlinePayment({ store, baseUrl, clientFactory, providerFactory }, { tenant, order: r.order, accessKey: r.accessKey });
      await sendOrderPlacedMails({ store, sendMail: getMailer(), baseUrl }, tenant, r.order, await publishedShopSettings(store, tenant), orderPageUrl(baseUrl, tenant, r.order.order_no, r.accessKey));
      return onlinePaymentResponse(pay);
    } catch (e) {
      // L2：金流建單失敗 → 取消（同交易釋放名額）並跑取消 hooks
      await cancelOrderWithHooks({ store, sendMail: getMailer(), baseUrl }, tenant, r.order.id, ["pending_payment"], "payment_init_failed");
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
          paymentMethod: formPaymentMethod(form.paymentMethod),
          couponCode: form.couponCode?.trim() || undefined,
          // 推薦碼只從 cookie 讀（同結帳）
          referralCode: cookieValue(req, referralCookieName(site.tenant.id)) || undefined,
          offerId: form.offerId || undefined,
          offerToken: form.offerToken || undefined,
        },
      },
    );
    // L6：網址不放 email 與簽到碼（會留在瀏覽紀錄／Referer）；簽到碼在確認信與會員中心
    if (r.kind === "free") return siteRedirect(req, slug, back, { ok: "報名成功！確認信（含簽到碼）已寄到你的信箱。" });
    if (r.kind === "pending") return siteRedirect(req, slug, back, { ok: "還差一步：請到信箱點確認連結完成報名（15 分鐘內有效，逾時名額會釋出）。" });
    if (r.kind === "waitlisted") return siteRedirect(req, slug, back, { ok: "目前待確認的報名較多，已改為候補登記：請到信箱點確認連結（30 分鐘內有效），有名額時會依順序通知你。" });
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
    if (r.pendingEmail) return siteRedirect(req, slug, back, { ok: "還差一步：請到信箱點確認連結完成候補登記（30 分鐘內有效）。" });
    return siteRedirect(req, slug, back, { ok: r.position > 0 ? `已登記候補（目前第 ${r.position} 位）。有名額時會寄信通知你。` : "剛好有名額釋出，已寄出遞補通知信，請到信箱點連結完成報名。" });
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}

/** M5：免費報名／候補的 email 確認（確認頁按鈕 POST；GET 只顯示按鈕，避免信箱掃描器預先點開就確認） */
export async function handleEventConfirm(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  try {
    const g = await guard(req, slug, "events", store, "event-confirm");
    if ("res" in g) return g.res!;
    const { site, form } = g;
    const kind = form.w ? "w" : "r";
    const r = await confirmEventEmail({ store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenant: site.tenant, kind, id: form.w || form.r, token: form.t });
    const msg = r.kind === "registration" ? (r.already ? "這筆報名已確認過了。" : "報名完成！確認信（含簽到碼）已寄到你的信箱。") : r.already ? "這筆候補已確認過了。" : "候補登記完成！有名額時會依順序寄信通知你。";
    return siteRedirect(req, slug, "/events/confirm", { ok: msg }, { done: "1" });
  } catch (e) {
    return siteRedirect(req, slug, "/events/confirm", { err: messageOf(e) }, { done: "1" });
  }
}

export async function handleBook(req: Request, rawSlug: string, store: Store = getStore(), clientFactory = pchomepayClientFor): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  let back = "/book";
  try {
    const g = await guard(req, slug, "booking", store, "booking-book");
    if ("res" in g) return g.res!;
    const { site, form, member, allowSandbox } = g;
    const sv = await store.getServiceById(site.tenant.id, form.serviceId ?? "");
    if (sv) back = `/book?service=${sv.slug}`;
    const r = await bookSlot(
      { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      {
        tenant: site.tenant,
        member,
        allowSandbox,
        data: {
          serviceId: form.serviceId,
          providerId: form.providerId || undefined,
          startsAt: form.startsAt,
          contact: contactFromForm(form),
          paymentMethod: formPaymentMethod(form.paymentMethod),
          couponCode: form.couponCode?.trim() || undefined,
          referralCode: cookieValue(req, referralCookieName(site.tenant.id)) || undefined,
          note: form.note?.trim() || undefined,
        },
      },
    );
    if (r.kind === "confirmed") {
      const u = new URL(r.manageUrl);
      return siteRedirect(req, slug, "/book/manage", { ok: `預約成功！確認信（含行事曆檔）已寄到 ${r.booking.contact.email}` }, { b: u.searchParams.get("b")!, t: u.searchParams.get("t")! });
    }
    return afterClassOrder(req, store, site.tenant, r, clientFactory);
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}

export async function handleBookingManage(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  let extra: Record<string, string> = {};
  try {
    const g = await guard(req, slug, "booking", store, "booking-manage");
    if ("res" in g) return g.res!;
    const { site, form } = g;
    extra = { b: form.b ?? "", t: form.t ?? "" };
    const deps = { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) };
    if (form.action === "cancel") {
      if (form.confirm !== "on") throw new ServiceError("confirm_required", "請勾選確認後再取消");
      const r = await selfCancelBooking(deps, { tenant: site.tenant, bookingId: form.b, token: form.t });
      return siteRedirect(req, slug, "/book/manage", { ok: r.refundRequired ? "預約已取消，店家會與你聯繫退款。" : "預約已取消。" }, extra);
    }
    if (form.action === "reschedule") {
      await selfRescheduleBooking(deps, { tenant: site.tenant, bookingId: form.b, token: form.t, startsAt: form.startsAt });
      return siteRedirect(req, slug, "/book/manage", { ok: "已改期，新的確認信（含行事曆檔）已寄出。" }, extra);
    }
    throw new ServiceError("invalid", "未知動作");
  } catch (e) {
    return siteRedirect(req, slug, "/book/manage", { err: messageOf(e) }, extra);
  }
}

export async function handleCourseBuy(req: Request, rawSlug: string, store: Store = getStore(), clientFactory = pchomepayClientFor): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  let back = "/courses";
  try {
    const g = await guard(req, slug, "courses", store, "course-buy");
    if ("res" in g) return g.res!;
    const { site, form, member, allowSandbox } = g;
    const c = await store.getCourseById(site.tenant.id, form.courseId ?? "");
    if (c) back = `/courses/${c.slug}`;
    const r = await buyCourse(
      { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      {
        tenant: site.tenant,
        member,
        allowSandbox,
        data: {
          courseId: form.courseId,
          contact: { name: form.name ?? "", phone: form.phone ?? "" },
          paymentMethod: formPaymentMethod(form.paymentMethod),
          couponCode: form.couponCode?.trim() || undefined,
          referralCode: cookieValue(req, referralCookieName(site.tenant.id)) || undefined,
        },
      },
    );
    if (r.kind === "enrolled") return siteRedirect(req, slug, back, { ok: "已加入課程，可以開始上課了！" });
    return afterClassOrder(req, store, site.tenant, r, clientFactory);
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}

export async function handleTopupBuy(req: Request, rawSlug: string, store: Store = getStore(), clientFactory = pchomepayClientFor): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  try {
    const g = await guard(req, slug, "stored-value", store, "wallet-topup");
    if ("res" in g) return g.res!;
    const { site, form, member, allowSandbox } = g;
    const r = await buyTopup(
      { store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) },
      { tenant: site.tenant, member, allowSandbox, data: { planId: form.planId, contact: { name: form.name ?? "", phone: form.phone ?? "" }, paymentMethod: formPaymentMethod(form.paymentMethod) } },
    );
    return afterClassOrder(req, store, site.tenant, r, clientFactory);
  } catch (e) {
    return siteRedirect(req, slug, "/wallet", { err: messageOf(e) });
  }
}

export async function handleCourseProgress(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  let back = "/courses";
  try {
    if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
    const site = await siteFor(slug, "courses", store);
    if (!site) return new NextResponse("not found", { status: 404 });
    const form = await formObject(req);
    back = `/learn/${encodeURIComponent(form.course ?? "")}/${encodeURIComponent(form.lesson ?? "")}`;
    const member = (await getSessionMember(store, site.tenant, memberTokenFromRequest(req, site.tenant)))?.member ?? null;
    await markLessonComplete(store, site.tenant, member, form.course ?? "", form.lesson ?? "");
    return siteRedirect(req, slug, back, { ok: "已標記完成" });
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}

/** 第七批：訂閱（會員登入 → 藍新定期定額表單自動送出）；取消訂閱（會員中心） */
export async function handleSubscribe(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  try {
    const g = await guard(req, slug, "subscriptions", store, "subscribe");
    if ("res" in g) return g.res!;
    const { site, form, member, allowSandbox } = g;
    const { subscribe } = await import("./services/subscriptions");
    const r = await subscribe({ store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenant: site.tenant, member, allowSandbox, data: { planId: form.planId } });
    return onlinePaymentResponse(r.form);
  } catch (e) {
    return siteRedirect(req, slug, "/account", { err: messageOf(e) });
  }
}

export async function handleSubscriptionCancel(req: Request, rawSlug: string, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  try {
    const g = await guard(req, slug, "subscriptions", store, "subscription-cancel");
    if ("res" in g) return g.res!;
    const { site, form, member } = g;
    const { memberCancelSubscription } = await import("./services/subscriptions");
    const r = await memberCancelSubscription({ store, sendMail: getMailer(), baseUrl: baseUrlFrom(req) }, { tenant: site.tenant, member, subscriptionId: form.subscriptionId ?? "" });
    return siteRedirect(req, slug, "/account", r.cancelState === "done" ? { ok: r.message } : { err: r.message });
  } catch (e) {
    return siteRedirect(req, slug, "/account", { err: messageOf(e) });
  }
}
