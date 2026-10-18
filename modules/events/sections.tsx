import type { z } from "zod";
import { localizeNested, localizeRow } from "@/lib/services/i18n";
import { getStore } from "@/lib/store";
import { renderMarkdown } from "@/lib/markdown";
import { currentMember } from "@/lib/site-request";
import { publicEventView, publicEvents, type PublicEvent } from "@/lib/services/events";
import { fmtTaipei, fmtTaipeiTime } from "@/lib/services/class-orders";
import type { MemberRow, WaitlistRow } from "@/lib/store/types";
import { ContactFields, PaymentFields, canPay, payOptionsFor, type PayOptions } from "@/components/site/ClassForms";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { eventDetailProps, eventsListProps } from "./manifest";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
const LOC: Record<string, string> = { physical: "實體", online: "線上", hybrid: "實體＋線上" };

function minPrice(v: PublicEvent) {
  const prices = v.sessions.flatMap((s) => s.tickets.map((t) => t.price));
  if (!prices.length) return null;
  const m = Math.min(...prices);
  return m === 0 ? "免費" : `${twd(m)} 起`;
}

export function EventCards({ ctx, items }: { ctx: RenderCtx; items: PublicEvent[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
      {items.map((v) => {
        const next = v.sessions[0]!;
        const full = v.sessions.every((s) => s.remaining <= 0);
        return (
          <a key={v.event.id} href={siteHref(ctx, `/events/${v.event.slug}`)} className="gb-card block overflow-hidden text-inherit no-underline" data-gb="event-card">
            {v.event.cover_url ? <img src={v.event.cover_url} alt="" loading="lazy" className="aspect-video w-full object-cover" /> : <div className="aspect-video w-full" style={{ background: "color-mix(in srgb, var(--gb-primary) 12%, transparent)" }} />}
            <div className="p-4">
              <h3 className="m-0 text-base font-bold">{v.event.title}</h3>
              <p className="gb-muted m-0 mt-1 text-sm">
                {fmtTaipei(next.starts_at)}
                {v.sessions.length > 1 ? `（共 ${v.sessions.length} 場）` : ""} · {LOC[v.event.location_type]}
                {v.event.location ? ` · ${v.event.location}` : ""}
              </p>
              <p className="m-0 mt-1 text-sm">
                {minPrice(v) ?? ""}
                {full && <span className="gb-muted ml-2">額滿（可候補）</span>}
              </p>
            </div>
          </a>
        );
      })}
    </div>
  );
}

export const EventsList: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof eventsListProps>;
  const items = await localizeNested(getStore(), ctx.site, "event", await publicEvents(getStore(), ctx.site.tenant, p.limit), "event");
  return (
    <section className="gb-section">
      <div className="gb-container">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
          {p.heading ? <h2 className="gb-h2 m-0">{p.heading}</h2> : <span />}
          {p.showAllLink && (
            <a href={siteHref(ctx, "/events")} className="text-sm" style={{ color: "var(--gb-primary)" }}>
              全部活動 →
            </a>
          )}
        </div>
        {items.length === 0 ? <p className="gb-muted">近期沒有活動。</p> : <EventCards ctx={ctx} items={items} />}
      </div>
    </section>
  );
};

/** 活動內容＋各場次報名表單（候補連結帶進來時只顯示該場次的認領表單） */
export function EventView({ ctx, view, member, pay, offer, offerToken }: { ctx: RenderCtx; view: PublicEvent; member: MemberRow | null; pay: PayOptions | null; offer?: WaitlistRow | null; offerToken?: string }) {
  const { event } = view;
  const slug = ctx.site.tenant.slug;
  const preview = ctx.site.mode === "preview" ? ctx.site.previewToken : null;
  const sessions = offer ? view.sessions.filter((s) => s.id === offer.session_id) : view.sessions;
  return (
    <div className="flex flex-col gap-6" data-gb="event-detail">
      {event.cover_url && <img src={event.cover_url} alt="" className="w-full rounded-[var(--gb-radius)] object-cover" style={{ maxHeight: 420 }} />}
      <div>
        <h1 className="gb-h2 m-0">{event.title}</h1>
        <p className="gb-muted m-0 mt-2 text-sm">
          {LOC[event.location_type]}
          {event.location ? ` · ${event.location}` : ""}
        </p>
        {event.summary && <p className="m-0 mt-3">{event.summary}</p>}
      </div>
      {offer && (
        <p className="gb-card m-0 p-3 text-sm" data-gb="offer-banner">
          候補遞補：已為你保留 {offer.qty} 個名額到 {fmtTaipei(offer.offer_expires_at!)}，請在期限內完成報名。
        </p>
      )}
      {sessions.length === 0 && <p className="gb-muted">{offer ? "這份候補保留已失效。" : "目前沒有可報名的場次。"}</p>}
      {sessions.map((s) => (
        <div key={s.id} className="gb-card flex flex-col gap-4 p-4 md:p-5" data-gb="event-session" data-session-id={s.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="m-0 text-lg font-bold">
              {fmtTaipei(s.starts_at)}–{fmtTaipeiTime(s.ends_at)}
            </h2>
            <span className="text-sm" data-gb="remaining">
              {offer ? "保留中" : s.remaining > 0 ? `剩 ${s.remaining} 位` : "額滿"}
            </span>
          </div>
          {s.tickets.length === 0 ? (
            <p className="gb-muted m-0 text-sm">票種準備中。</p>
          ) : (
            <form method="post" action={`/s/${slug}/api/events/register`} className="flex flex-col gap-3" data-gb="register-form">
              <input type="hidden" name="sessionId" value={s.id} />
              {preview && <input type="hidden" name="preview" value={preview} />}
              {offer && (
                <>
                  <input type="hidden" name="offerId" value={offer.id} />
                  <input type="hidden" name="offerToken" value={offerToken ?? ""} />
                </>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                <label className="flex flex-col gap-1 text-sm font-medium">
                  票種
                  <select className="gb-input" name="ticketTypeId" defaultValue={offer?.ticket_type_id}>
                    {s.tickets
                      .filter((t) => !offer || t.id === offer.ticket_type_id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}　{t.price === 0 ? "免費" : twd(t.price)}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium">
                  張數
                  <input className="gb-input" name="qty" type="number" min={1} max={offer ? offer.qty : Math.max(...s.tickets.map((t) => t.max_per_order))} defaultValue={offer?.qty ?? 1} style={{ width: "6rem" }} />
                </label>
              </div>
              <ContactFields member={member} />
              {s.tickets.some((t) => t.price > 0) && (canPay(pay) ? <PaymentFields pay={pay!} /> : <p className="gb-muted m-0 text-xs">付費票目前未開放線上付款。</p>)}
              <div className="flex flex-wrap gap-3">
                <button type="submit" className="gb-btn" disabled={!offer && s.remaining <= 0}>
                  {offer ? "完成報名" : "報名"}
                </button>
                {!offer && s.remaining <= 0 && (
                  <button type="submit" formAction={`/s/${slug}/api/events/waitlist`} className="gb-btn" style={{ background: "var(--gb-text)" }} data-gb="waitlist-btn">
                    登記候補
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      ))}
      {event.body_md && <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(event.body_md) }} />}
    </div>
  );
}

export const EventDetail: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof eventDetailProps>;
  const store = getStore();
  const e = await localizeRow(store, ctx.site, "event", await store.getEventBySlug(ctx.site.tenant.id, p.eventSlug));
  if (!e || e.status !== "published") return null;
  const [view, member, pay] = await Promise.all([publicEventView(store, ctx.site.tenant, e), currentMember(ctx.site.tenant), payOptionsFor(ctx.site)]);
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <EventView ctx={ctx} view={view} member={member} pay={pay} />
      </div>
    </section>
  );
};
