import type { z } from "zod";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { pendingMustRead, visibleAnnouncements } from "@/lib/services/announcements";
import { renderMarkdown } from "@/lib/markdown";
import { fmtTaipei } from "@/lib/services/class-orders";
import type { AnnouncementRow } from "@/lib/store/types";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { announcementsBarProps, announcementsListProps } from "./manifest";

export function AnnouncementCards({ items }: { items: AnnouncementRow[] }) {
  if (!items.length) return <p className="gb-muted">目前沒有公告。</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0" data-gb="announcements">
      {items.map((a) => (
        <li key={a.id} id={`ann-${a.id}`} className="gb-card p-4">
          <strong className="block">
            {a.pinned && <span className="mr-2 text-xs" style={{ color: "var(--gb-primary)" }}>置頂</span>}
            {a.title}
          </strong>
          <span className="gb-muted text-xs">{fmtTaipei(a.starts_at ?? a.created_at, false)}</span>
          {a.body_md && <div className="gb-prose mt-2 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body_md) }} />}
        </li>
      ))}
    </ul>
  );
}

export const AnnouncementsBar: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof announcementsBarProps>;
  const member = await currentMember(ctx.site.tenant);
  const items = (await visibleAnnouncements(getStore(), ctx.site.tenant, member)).slice(0, p.limit);
  if (!items.length) return null;
  return (
    <div className="py-2 text-sm" style={{ background: "var(--gb-surface)" }} data-gb="announcements-bar">
      <div className="gb-container flex flex-col gap-1">
        {items.map((a) => (
          <a key={a.id} href={siteHref(ctx, `/announcements#ann-${a.id}`)} className="no-underline" style={{ color: "var(--gb-text)" }}>
            📢 {a.title}
          </a>
        ))}
      </div>
    </div>
  );
};

export const AnnouncementsList: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof announcementsListProps>;
  const member = await currentMember(ctx.site.tenant);
  const items = (await visibleAnnouncements(getStore(), ctx.site.tenant, member)).slice(0, p.limit);
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <AnnouncementCards items={items} />
      </div>
    </section>
  );
};

/** 網站外框：登入會員有未確認的必讀公告 → 頂端顯示並要求按確認 */
export async function MustReadBanner({ ctx }: { ctx: RenderCtx }) {
  const member = await currentMember(ctx.site.tenant);
  if (!member) return null;
  const items = await pendingMustRead(getStore(), ctx.site.tenant, member);
  if (!items.length) return null;
  return (
    <div className="border-b px-4 py-3 text-sm" style={{ background: "#fffbeb", borderColor: "#fcd34d", color: "#78350f" }} data-gb="must-read" role="region" aria-label="必讀公告">
      <div className="gb-container flex flex-col gap-3">
        {items.map((a) => (
          <div key={a.id} className="flex flex-col gap-2">
            <strong>必讀：{a.title}</strong>
            {a.body_md && <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body_md) }} />}
            <form method="post" action={`/s/${ctx.site.tenant.slug}/api/announcements/ack`}>
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="back" value={ctx.path} />
              <button className="gb-btn" type="submit" data-gb="ack-button">
                我已閱讀並確認
              </button>
            </form>
          </div>
        ))}
      </div>
    </div>
  );
}
