import type { z } from "zod";
import { localizeNested, localizeRow } from "@/lib/services/i18n";
import { getStore } from "@/lib/store";
import { renderMarkdown } from "@/lib/markdown";
import { currentMember } from "@/lib/site-request";
import { canAccessCourse, publicCourses } from "@/lib/services/courses";
import type { CourseRow, MemberRow } from "@/lib/store/types";
import { PaymentFields, canPay, payOptionsFor, type PayOptions } from "@/components/site/ClassForms";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { courseDetailProps, coursesListProps } from "./manifest";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;
type CourseItem = { course: CourseRow; lessons: { slug: string; title: string; isPreview: boolean }[] };

export function CourseCards({ ctx, items }: { ctx: RenderCtx; items: CourseItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
      {items.map(({ course: c, lessons }) => (
        <a key={c.id} href={siteHref(ctx, `/courses/${c.slug}`)} className="gb-card block overflow-hidden text-inherit no-underline" data-gb="course-card">
          {c.cover_url ? <img src={c.cover_url} alt="" loading="lazy" className="aspect-video w-full object-cover" /> : <div className="aspect-video w-full" style={{ background: "color-mix(in srgb, var(--gb-primary) 12%, transparent)" }} />}
          <div className="p-4">
            <h3 className="m-0 text-base font-bold">{c.title}</h3>
            <p className="gb-muted m-0 mt-1 text-sm">
              {lessons.length} 個單元 · {c.price ? twd(c.price) : "免費"}
            </p>
          </div>
        </a>
      ))}
    </div>
  );
}

export const CoursesList: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof coursesListProps>;
  const items = await localizeNested(getStore(), ctx.site, "course", (await publicCourses(getStore(), ctx.site.tenant)).slice(0, p.limit), "course");
  return (
    <section className="gb-section">
      <div className="gb-container">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
          {p.heading ? <h2 className="gb-h2 m-0">{p.heading}</h2> : <span />}
          {p.showAllLink && (
            <a href={siteHref(ctx, "/courses")} className="text-sm" style={{ color: "var(--gb-primary)" }}>
              全部課程 →
            </a>
          )}
        </div>
        {items.length === 0 ? <p className="gb-muted">課程準備中。</p> : <CourseCards ctx={ctx} items={items} />}
      </div>
    </section>
  );
};

/** 課程介紹＋單元大綱（只有標題；付費單元內容與影片網址不在這頁）＋購買／上課 */
export function CourseView({ ctx, item, member, enrolled, pay }: { ctx: RenderCtx; item: CourseItem; member: MemberRow | null; enrolled: boolean; pay: PayOptions | null }) {
  const { course: c, lessons } = item;
  const slug = ctx.site.tenant.slug;
  const preview = ctx.site.mode === "preview" ? ctx.site.previewToken : null;
  return (
    <div className="flex flex-col gap-6" data-gb="course-detail">
      {c.cover_url && <img src={c.cover_url} alt="" className="w-full rounded-[var(--gb-radius)] object-cover" style={{ maxHeight: 420 }} />}
      <div>
        <h1 className="gb-h2 m-0">{c.title}</h1>
        {c.summary && <p className="m-0 mt-2">{c.summary}</p>}
        <p className="m-0 mt-2 font-bold">{c.price ? twd(c.price) : "免費"}</p>
      </div>
      <div className="gb-card p-4" data-gb="course-cta">
        {enrolled ? (
          <a className="gb-btn" href={siteHref(ctx, `/learn/${c.slug}/${lessons[0]?.slug ?? ""}`)} data-gb="start-learning">
            開始上課
          </a>
        ) : !member ? (
          <p className="m-0 text-sm">
            購買課程需要會員帳號：<a href={siteHref(ctx, `/account/login?next=/courses/${c.slug}`)}>登入</a> 或 <a href={siteHref(ctx, "/account/register")}>註冊</a>
          </p>
        ) : c.price > 0 && !canPay(pay) ? (
          <p className="gb-muted m-0 text-sm">目前未開放線上購買。</p>
        ) : (
          <form method="post" action={`/s/${slug}/api/courses/buy`} className="flex flex-col gap-3" data-gb="buy-form">
            <input type="hidden" name="courseId" value={c.id} />
            {preview && <input type="hidden" name="preview" value={preview} />}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-medium">
                姓名
                <input className="gb-input" name="name" required maxLength={80} defaultValue={member.name ?? ""} />
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">
                電話
                <input className="gb-input" name="phone" type="tel" required minLength={6} maxLength={40} defaultValue={member.phone ?? ""} />
              </label>
            </div>
            {c.price > 0 && <PaymentFields pay={pay!} />}
            <button className="gb-btn self-start" type="submit">
              {c.price > 0 ? `購買 ${twd(c.price)}` : "免費加入"}
            </button>
          </form>
        )}
      </div>
      <div>
        <h2 className="m-0 mb-2 text-lg font-bold">課程單元</h2>
        <ol className="m-0 flex flex-col gap-1 pl-5 text-sm" data-gb="outline">
          {lessons.map((l) => (
            <li key={l.slug}>
              {enrolled || l.isPreview ? <a href={siteHref(ctx, `/learn/${c.slug}/${l.slug}`)}>{l.title}</a> : l.title}
              {l.isPreview && !enrolled && <span className="gb-muted ml-2 text-xs">免費試看</span>}
            </li>
          ))}
        </ol>
      </div>
      {c.body_md && <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body_md) }} />}
    </div>
  );
}

export const CourseDetail: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof courseDetailProps>;
  const store = getStore();
  const found = (await publicCourses(store, ctx.site.tenant)).find((x) => x.course.slug === p.courseSlug);
  if (!found) return null;
  const item = { ...found, course: (await localizeRow(store, ctx.site, "course", found.course))! };
  const [member, pay] = await Promise.all([currentMember(ctx.site.tenant), payOptionsFor(ctx.site)]);
  const enrolled = await canAccessCourse(store, ctx.site.tenant, item.course, member);
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <CourseView ctx={ctx} item={item} member={member} enrolled={enrolled} pay={pay} />
      </div>
    </section>
  );
};
