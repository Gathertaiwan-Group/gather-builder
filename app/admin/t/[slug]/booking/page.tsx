import { notFound } from "next/navigation";
import { AdminShell, Card } from "@/components/admin/AdminShell";
import { TenantTabs } from "@/components/admin/TenantTabs";
import { requireBackoffice } from "@/lib/backoffice";
import { listBookings, listServices, revealBooking } from "@/lib/services/booking";
import { addDays, taipeiDateOf, weekdayOf } from "@/lib/booking/availability";
import { fmtTaipeiTime } from "@/lib/services/class-orders";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

const W = "日一二三四五六";
const STATUS: Record<string, string> = { held: "待付款", confirmed: "已確認", cancelled: "已取消", expired: "逾期" };

/** 週曆（7 欄，手機可橫向捲動）＋可查看完整資料（留紀錄）＋店家取消 */
export default async function BookingAdmin({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ ok?: string; err?: string; week?: string; reveal?: string }> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const bo = await requireBackoffice(slug);
  const ctx = bo.ctx;
  const tenant = bo.tenant;
  const today = taipeiDateOf(new Date());
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
  const week = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : monday;
  const from = new Date(Date.parse(`${week}T00:00:00+08:00`)).toISOString();
  const to = new Date(Date.parse(`${addDays(week, 7)}T00:00:00+08:00`)).toISOString();
  const r = await listBookings(ctx, { site: slug, from, to }).catch((e) => (e instanceof ServiceError ? { error: e.message } : Promise.reject(e)));
  const svc = "error" in r ? null : await listServices(ctx, { site: slug });
  const revealed = sp.reveal ? await revealBooking(ctx, { site: slug, bookingId: sp.reveal }).catch(() => null) : null;
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const act = `${bo.api}/booking/action`;
  return (
    <AdminShell sp={sp} bo={bo}>
      <TenantTabs bo={bo} active="/booking" name={tenant.name} />
      {"error" in r ? (
        <Card title="預約">
          <p className="m-0 text-sm text-neutral-600">{r.error}</p>
        </Card>
      ) : (
        <>
          <Card title={`週曆 ${week} 起（${r.total} 筆）`}>
            <div className="mb-3 flex justify-between text-sm">
              <a href={`${bo.base}/booking?week=${addDays(week, -7)}`}>← 上一週</a>
              <a href={`${bo.base}/booking`}>本週</a>
              <a href={`${bo.base}/booking?week=${addDays(week, 7)}`}>下一週 →</a>
            </div>
            {revealed && (
              <p className="rounded bg-amber-50 p-2 text-sm" data-admin="revealed">
                {revealed.contact.name}・{revealed.contact.email}・{revealed.contact.phone}
              </p>
            )}
            <div className="overflow-x-auto">
              <div className="grid min-w-[840px] grid-cols-7 gap-2 text-xs" data-admin="booking-week">
                {days.map((d) => (
                  <div key={d} className="rounded border p-2" style={d === today ? { borderColor: "#171717" } : undefined}>
                    <p className="m-0 mb-2 font-semibold">
                      {d.slice(5)}（{W[weekdayOf(d)]}）
                    </p>
                    {r.bookings
                      .filter((b) => taipeiDateOf(new Date(b.startsAt)) === d)
                      .map((b) => (
                        <div key={b.id} className="mb-2 rounded bg-neutral-50 p-1" data-admin="booking" data-status={b.status} style={b.status === "cancelled" || b.status === "expired" ? { opacity: 0.5 } : undefined}>
                          <p className="m-0 font-semibold">
                            {fmtTaipeiTime(b.startsAt)} {b.service}
                          </p>
                          <p className="m-0">
                            {b.contact.name}・{STATUS[b.status]}
                            {b.refundRequired ? "・待退款" : ""}
                          </p>
                          <form method="get" className="inline">
                            <input type="hidden" name="week" value={week} />
                            <input type="hidden" name="reveal" value={b.id} />
                            <button className="underline" type="submit">
                              查看
                            </button>
                          </form>
                          {(b.status === "held" || b.status === "confirmed") && (
                            <form action={act} method="post" className="mt-1 flex items-center gap-1">
                              <input type="hidden" name="action" value="cancel" />
                              <input type="hidden" name="week" value={week} />
                              <input type="hidden" name="bookingId" value={b.id} />
                              <input type="checkbox" name="confirm" required aria-label="確認取消" />
                              <button className="text-red-700 underline" type="submit">
                                取消
                              </button>
                            </form>
                          )}
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          </Card>
          {svc && (
            <Card title="服務與時段">
              <ul className="m-0 text-sm">
                {svc.services.map((s) => (
                  <li key={s.id}>
                    {s.name}（{s.durationMin} 分＋緩衝 {s.bufferMin} 分・NT${s.price}・{s.paymentMode}・{s.status}）
                  </li>
                ))}
              </ul>
              <p className="mb-0 text-xs text-neutral-600">
                每週時段：{svc.weeklyHours.map((h) => `週${W[h.weekday]} ${h.start}–${h.end}`).join("、") || "（未設定）"}。用 MCP set_weekly_hours／add_date_override 修改。
              </p>
            </Card>
          )}
        </>
      )}
    </AdminShell>
  );
}
