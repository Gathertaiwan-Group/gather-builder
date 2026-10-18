import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { currentMember } from "@/lib/site-request";
import { moduleActive } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel, Field } from "@/components/site/AccountForm";
import { siteHref } from "@/modules/render-types";
import { ORDER_STATUS_LABEL } from "@/lib/shop/machine";
import { twd } from "@/modules/shop/sections";
import { expireIfDue } from "@/lib/services/orders";
import { getOrCreateReferralCode, shareUrl } from "@/lib/services/referral";
import { headers } from "next/headers";
import { baseUrlFrom } from "@/lib/runtime";
import { INVOICE_LABEL, SHIPMENT_LABEL } from "@/lib/order-labels";
import { memberRegistrations } from "@/lib/services/events";
import { manageUrl, memberBookings } from "@/lib/services/booking";
import { memberCourses } from "@/lib/services/courses";
import { fmtTaipei } from "@/lib/services/class-orders";
import { MemberPoints, MemberWallet } from "@/components/site/MemberCredits";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "會員中心", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ ok?: string; err?: string }> };

export default async function AccountPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  const member = await currentMember(site.tenant);
  if (!member) redirect(`/s/${site.tenant.slug}/account/login`);
  const ctx = makeRenderCtx(site, "/account");
  const baseUrl = baseUrlFrom({ headers: await headers() });
  const store = getStore();
  const listed = moduleActive(site, "shop") ? (await store.listOrders(site.tenant.id, { memberId: member.id, limit: 50, offset: 0 })).rows : [];
  // 逾期未付的訂單在讀取時 lazy 取消（冪等）
  const orders = await Promise.all(listed.map((o) => expireIfDue(store, o)));
  // 發票號與物流追蹤號（有啟用對應模組才有資料）
  const extras = await Promise.all(
    orders.map(async (o) => ({
      invoice: o.invoice_status ? await store.getInvoiceByOrder(site.tenant.id, o.id) : null,
      shipment: await store.getActiveShipmentByOrder(site.tenant.id, o.id),
    })),
  );
  const action = (p: string) => `/s/${site.tenant.slug}/api/account/${p}`;
  const myRegs = moduleActive(site, "events") ? await memberRegistrations(store, site.tenant, member) : [];
  const myCourses = moduleActive(site, "courses") ? await memberCourses(store, site.tenant, member) : [];
  const myBookings = moduleActive(site, "booking") ? await memberBookings(store, site.tenant, member) : [];
  const myCode = moduleActive(site, "referral") ? await getOrCreateReferralCode(store, site.tenant, member) : null;
  return (
    <SiteShell ctx={ctx}>
      <AccountPanel title="會員中心" sp={sp}>
        <p className="m-0 mb-4 text-sm" data-gb="member-email">
          {member.email} {member.email_verified_at ? "（已驗證）" : "（尚未驗證 Email）"}
        </p>
        <form method="post" action={action("profile")} className="gb-card mb-6 flex flex-col gap-4 p-5">
          <h2 className="m-0 text-lg font-bold">個人資料</h2>
          <Field label="姓名" name="name" defaultValue={member.name ?? ""} maxLength={80} autoComplete="name" />
          <Field label="電話" name="phone" defaultValue={member.phone ?? ""} maxLength={40} autoComplete="tel" type="tel" />
          <button className="gb-btn self-start" type="submit">
            儲存
          </button>
        </form>
        {moduleActive(site, "loyalty") && <MemberPoints tenant={site.tenant} member={member} />}
        {moduleActive(site, "stored-value") && (
          <>
            <MemberWallet tenant={site.tenant} member={member} />
            <p className="-mt-4 mb-6 text-sm">
              <a href={siteHref(ctx, "/wallet")} data-gb="wallet-link">儲值 →</a>
            </p>
          </>
        )}
        {moduleActive(site, "shop") && (
          <div className="gb-card mb-6 p-5" data-gb="my-orders">
            <h2 className="m-0 mb-3 text-lg font-bold">我的訂單</h2>
            {orders.length === 0 ? (
              <p className="gb-muted m-0 text-sm">還沒有訂單。</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {orders.map((o, i) => {
                  const inv = extras[i]?.invoice;
                  const sh = extras[i]?.shipment;
                  return (
                    <li key={o.id} className="flex flex-wrap justify-between gap-2 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
                      <a href={siteHref(ctx, `/orders/${o.order_no}`)} data-gb="order-link">
                        {o.order_no}
                      </a>
                      <span>
                        {ORDER_STATUS_LABEL[o.status]} · {twd(o.total)}
                      </span>
                      {(inv?.invoice_no || sh) && (
                        <span className="gb-muted w-full text-xs">
                          {inv?.invoice_no && <span data-gb="invoice-no">發票 {inv.invoice_no}（{INVOICE_LABEL[inv.status] ?? inv.status}）</span>}
                          {inv?.invoice_no && sh && " · "}
                          {sh && (
                            <span data-gb="shipment">
                              {SHIPMENT_LABEL[sh.status] ?? sh.status}
                              {sh.tracking_no && <> · 追蹤號 <span data-gb="tracking-no">{sh.tracking_no}</span></>}
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {moduleActive(site, "courses") && (
          <div className="gb-card mb-6 p-5" data-gb="my-courses">
            <h2 className="m-0 mb-3 text-lg font-bold">我的課程</h2>
            {myCourses.length === 0 ? (
              <p className="gb-muted m-0 text-sm">
                還沒有課程。<a href={siteHref(ctx, "/courses")}>看看課程</a>
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {myCourses.map((c) => (
                  <li key={c.course.id} className="flex flex-wrap justify-between gap-2 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
                    <a href={siteHref(ctx, c.first ? `/learn/${c.course.slug}/${c.first}` : `/courses/${c.course.slug}`)} data-gb="my-course-link">
                      {c.course.title}
                    </a>
                    <span>
                      進度 {c.done}/{c.total}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {moduleActive(site, "events") && (
          <div className="gb-card mb-6 p-5" data-gb="my-registrations">
            <h2 className="m-0 mb-3 text-lg font-bold">我的報名</h2>
            {myRegs.length === 0 ? (
              <p className="gb-muted m-0 text-sm">還沒有報名紀錄。</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {myRegs.map(({ reg, session, event, code }) => (
                  <li key={reg.id} className="flex flex-wrap justify-between gap-2 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
                    <a href={siteHref(ctx, `/events/${event.slug}`)}>{event.title}</a>
                    <span>
                      {fmtTaipei(session.starts_at)} · {reg.status === "confirmed" ? "已確認" : reg.status === "held" ? "待付款" : "已取消"}
                      {session.status === "cancelled" ? "（場次已取消）" : ""}
                    </span>
                    {code && <span className="gb-muted w-full text-xs">簽到碼 <span data-gb="checkin-code">{code}</span></span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {moduleActive(site, "booking") && (
          <div className="gb-card mb-6 p-5" data-gb="my-bookings">
            <h2 className="m-0 mb-3 text-lg font-bold">我的預約</h2>
            {myBookings.length === 0 ? (
              <p className="gb-muted m-0 text-sm">還沒有預約。</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {myBookings.map(({ booking: b, service }) => (
                  <li key={b.id} className="flex flex-wrap justify-between gap-2 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
                    <span>{service?.name ?? "預約"}</span>
                    <span>
                      {fmtTaipei(b.starts_at)} · {b.status === "confirmed" ? "已確認" : b.status === "held" ? "待付款" : "已取消"}
                    </span>
                    {(b.status === "confirmed" || b.status === "held") && (
                      <a className="w-full text-xs" href={manageUrl(baseUrl, site.tenant, b)}>
                        管理（取消／改期）
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {myCode && (
          <div className="gb-card mb-6 p-5 text-sm" data-gb="referral">
            <h2 className="m-0 mb-2 text-lg font-bold">推薦好友</h2>
            <p className="m-0">
              你的推薦碼：<strong data-gb="referral-code">{myCode.code}</strong>
            </p>
            <p className="m-0 mt-1 break-all">
              分享連結：<span data-gb="referral-link">{shareUrl(baseUrl, site.tenant, myCode.code)}</span>
            </p>
            <p className="gb-muted m-0 mt-2 text-xs">朋友透過連結完成第一筆訂單後，你會收到一張回饋券。</p>
          </div>
        )}
        <form method="post" action={action("logout")}>
          <button className="text-sm underline" type="submit" style={{ background: "none", border: 0, color: "var(--gb-text)", cursor: "pointer" }}>
            登出
          </button>
        </form>
      </AccountPanel>
    </SiteShell>
  );
}
