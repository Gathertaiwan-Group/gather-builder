import type { z } from "zod";
import { getStore } from "@/lib/store";
import { renderMarkdown } from "@/lib/markdown";
import { availabilityFor, publicServices } from "@/lib/services/booking";
import { fmtTaipeiTime } from "@/lib/services/class-orders";
import { addDays, taipeiDateOf } from "@/lib/booking/availability";
import type { MemberRow, ServiceRow } from "@/lib/store/types";
import { ContactFields, PaymentFields, canPay, type PayOptions } from "@/components/site/ClassForms";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { bookingWidgetProps } from "./manifest";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const W = "日一二三四五六";

export function priceLabel(s: ServiceRow) {
  if (s.price === 0) return "免費";
  if (s.payment_mode === "deposit") return `${twd(s.price)}（線上付訂金 ${twd(s.deposit_amount ?? 0)}）`;
  if (s.payment_mode === "full") return `${twd(s.price)}（線上付款）`;
  return `${twd(s.price)}（現場付款）`;
}

export function ServiceCards({ ctx, services }: { ctx: RenderCtx; services: ServiceRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-gb="services">
      {services.map((s) => (
        <a key={s.id} href={siteHref(ctx, `/book?service=${s.slug}`)} className="gb-card block p-4 text-inherit no-underline" data-gb="service-card">
          <h3 className="m-0 text-base font-bold">{s.name}</h3>
          <p className="gb-muted m-0 mt-1 text-sm">
            {s.duration_min} 分鐘 · {priceLabel(s)}
          </p>
        </a>
      ))}
    </div>
  );
}

export const BookingWidget: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof bookingWidgetProps>;
  const all = await publicServices(getStore(), ctx.site.tenant);
  const services = p.serviceSlug ? all.filter((s) => s.slug === p.serviceSlug) : all;
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {services.length === 0 ? <p className="gb-muted">目前沒有開放預約的服務。</p> : <ServiceCards ctx={ctx} services={services} />}
      </div>
    </section>
  );
};

/** 選時段（未來 7 天，可前後翻頁）→ 選好時段後顯示確認表單 */
export async function BookingFlow({ ctx, service, from, slot, member, pay }: { ctx: RenderCtx; service: ServiceRow; from?: string; slot?: string; member: MemberRow | null; pay: PayOptions | null }) {
  const store = getStore();
  const today = taipeiDateOf(new Date());
  const start = from && /^\d{4}-\d{2}-\d{2}$/.test(from) && from >= today ? from : today;
  const { days } = await availabilityFor(store, ctx.site.tenant, service, { fromDate: start, days: 7 });
  const slug = ctx.site.tenant.slug;
  const preview = ctx.site.mode === "preview" ? ctx.site.previewToken : null;
  const picked = slot ? days.flatMap((d) => d.slots).find((x) => x.start === slot) : undefined;
  const needsPay = service.payment_mode !== "none" && service.price > 0;
  const base = `/book?service=${service.slug}`;
  return (
    <div className="flex flex-col gap-5" data-gb="booking-flow">
      <div>
        <h1 className="gb-h2 m-0">{service.name}</h1>
        <p className="gb-muted m-0 mt-2 text-sm">
          {service.duration_min} 分鐘 · {priceLabel(service)}
        </p>
      </div>
      {service.description_md && <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(service.description_md) }} />}
      {picked ? (
        <form method="post" action={`/s/${slug}/api/booking/book`} className="gb-card flex flex-col gap-4 p-4 md:p-5" data-gb="booking-form">
          <p className="m-0 font-bold" data-gb="picked-slot">
            {`${taipeiDateOf(new Date(picked.start))}（週${W[new Date(Date.parse(picked.start) + 8 * 3600_000).getUTCDay()]}）${fmtTaipeiTime(picked.start)}–${fmtTaipeiTime(picked.end)}`}
          </p>
          <input type="hidden" name="serviceId" value={service.id} />
          <input type="hidden" name="startsAt" value={picked.start} />
          {preview && <input type="hidden" name="preview" value={preview} />}
          <ContactFields member={member} />
          <label className="flex flex-col gap-1 text-sm font-medium">
            備註（選填）
            <textarea className="gb-input" name="note" maxLength={500} rows={2} />
          </label>
          {needsPay && (canPay(pay) ? <PaymentFields pay={pay!} /> : <p className="gb-muted m-0 text-xs">目前未開放線上付款。</p>)}
          <div className="flex flex-wrap gap-3">
            <button className="gb-btn" type="submit" disabled={needsPay && !canPay(pay)}>
              確認預約
            </button>
            <a href={siteHref(ctx, `${base}&from=${start}`)} className="self-center text-sm">
              重新選時段
            </a>
          </div>
        </form>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm">
            {start > today ? <a href={siteHref(ctx, `${base}&from=${addDays(start, -7) < today ? today : addDays(start, -7)}`)}>← 前一週</a> : <span />}
            <a href={siteHref(ctx, `${base}&from=${addDays(start, 7)}`)} data-gb="next-week">
              下一週 →
            </a>
          </div>
          <div className="flex flex-col gap-3">
            {days.map((d) => (
              <div key={d.date} className="gb-card p-3" data-gb="booking-day" data-date={d.date}>
                <p className="m-0 mb-2 text-sm font-bold">
                  {d.date.slice(5).replace("-", "/")}（週{W[d.weekday]}）
                </p>
                {d.slots.length === 0 ? (
                  <p className="gb-muted m-0 text-xs">無可預約時段</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {d.slots.map((x) => (
                      <a key={x.start} href={siteHref(ctx, `${base}&from=${start}&slot=${encodeURIComponent(x.start)}`)} className="rounded border px-3 py-1 text-sm no-underline" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 20%, transparent)", color: "var(--gb-text)" }} data-gb="slot" data-start={x.start}>
                        {fmtTaipeiTime(x.start)}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
