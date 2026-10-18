import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { availabilityFor, bookingSettingsFor, managedBooking } from "@/lib/services/booking";
import { canSelfCancel, taipeiDateOf } from "@/lib/booking/availability";
import { fmtTaipei, fmtTaipeiTime } from "@/lib/services/class-orders";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { Flash } from "@/components/site/ClassForms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "管理預約", robots: { index: false }, referrer: "no-referrer" };

const STATUS: Record<string, string> = { held: "待付款", confirmed: "已確認", cancelled: "已取消", expired: "已逾期（未付款）" };

/** 客人自助取消／改期（簽章連結；網址含一次性簽章 → 不載入 GA、no-referrer） */
export default async function ManageBooking(props: { params: Promise<{ site: string }>; searchParams: Promise<{ b?: string; t?: string; ok?: string; err?: string; date?: string }> }) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "booking");
  if (!site) notFound();
  const store = getStore();
  const m = await managedBooking(store, site.tenant, sp.b, sp.t);
  const ctx = makeRenderCtx(site, "/book/manage");
  const settings = await bookingSettingsFor(store, site.tenant);
  const live = m && ["held", "confirmed"].includes(m.booking.status);
  const can = !!m && !!live && canSelfCancel(m.booking.starts_at, new Date(), settings.cancelDeadlineHours);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : m ? taipeiDateOf(new Date(m.booking.starts_at)) : undefined;
  const avail = can && m ? (await availabilityFor(store, site.tenant, m.service, { providerId: m.booking.provider_id, fromDate: date, days: 1 })).days[0] : null;
  const action = `/s/${site.tenant.slug}/api/booking/manage`;
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-xl">
          <h1 className="gb-h2">管理預約</h1>
          <Flash sp={sp} />
          {!m ? (
            <p className="gb-card p-4">預約連結無效。</p>
          ) : (
            <div className="gb-card flex flex-col gap-3 p-4" data-gb="managed-booking" data-status={m.booking.status}>
              <p className="m-0 font-bold">{m.service.name}</p>
              <p className="m-0 text-sm">
                {fmtTaipei(m.booking.starts_at)}–{fmtTaipeiTime(m.booking.ends_at)} · {STATUS[m.booking.status]}
              </p>
              {live && (
                <a href={`/s/${site.tenant.slug}/book/ics?b=${encodeURIComponent(m.booking.id)}&t=${encodeURIComponent(sp.t ?? "")}`} className="text-sm" data-gb="ics-link">
                  下載行事曆檔（.ics）
                </a>
              )}
              {live && !can && <p className="gb-muted m-0 text-sm">開始前 {settings.cancelDeadlineHours} 小時內無法線上取消或改期，請直接聯絡店家。</p>}
              {can && (
                <>
                  <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
                    <input type="hidden" name="b" value={m.booking.id} />
                    <input type="hidden" name="t" value={sp.t} />
                    <label className="flex flex-col gap-1">
                      改到哪一天
                      <input className="gb-input" type="date" name="date" defaultValue={date} />
                    </label>
                    <button className="gb-btn" type="submit" style={{ background: "var(--gb-text)" }}>
                      查看時段
                    </button>
                  </form>
                  {avail && (
                    <form method="post" action={action} className="flex flex-wrap items-center gap-2 text-sm" data-gb="reschedule-form">
                      <input type="hidden" name="action" value="reschedule" />
                      <input type="hidden" name="b" value={m.booking.id} />
                      <input type="hidden" name="t" value={sp.t} />
                      {avail.slots.length === 0 ? (
                        <span className="gb-muted">這天沒有可預約時段</span>
                      ) : (
                        <>
                          <select className="gb-input" name="startsAt" style={{ width: "auto" }}>
                            {avail.slots.map((x) => (
                              <option key={x.start} value={x.start}>
                                {fmtTaipeiTime(x.start)}
                              </option>
                            ))}
                          </select>
                          <button className="gb-btn" type="submit">
                            改期
                          </button>
                        </>
                      )}
                    </form>
                  )}
                  <form method="post" action={action} className="flex flex-wrap items-center gap-2 text-sm">
                    <input type="hidden" name="action" value="cancel" />
                    <input type="hidden" name="b" value={m.booking.id} />
                    <input type="hidden" name="t" value={sp.t} />
                    <label className="flex items-center gap-1">
                      <input type="checkbox" name="confirm" required />
                      確定取消這筆預約
                    </label>
                    <button className="gb-btn" type="submit" style={{ background: "#b91c1c" }}>
                      取消預約
                    </button>
                  </form>
                </>
              )}
            </div>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
