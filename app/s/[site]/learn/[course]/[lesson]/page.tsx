import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { lessonForViewer } from "@/lib/services/courses";
import { renderMarkdown } from "@/lib/markdown";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { Flash } from "@/components/site/ClassForms";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { robots: { index: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ site: string; course: string; lesson: string }>; searchParams: Promise<{ preview?: string; ok?: string; err?: string }> };

/**
 * 上課頁。🔴 權限在 server 端（lessonForViewer）：未開通且不是試看單元時，拿到的 lesson 沒有影片網址、內容與附件，
 * 這頁只用它渲染，所以付費影片網址不會出現在 HTML。
 */
export default async function LessonPage(props: Props) {
  const [{ site: raw, course, lesson }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "courses", sp.preview);
  if (!site) notFound();
  const member = await currentMember(site.tenant);
  const v = await lessonForViewer(getStore(), site.tenant, course, lesson, member, { preview: site.mode === "preview" });
  if (!v) notFound();
  const ctx = makeRenderCtx(site, `/learn/${course}/${lesson}`);
  const L = v.lesson;
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container grid grid-cols-1 gap-6 md:grid-cols-[1fr_260px]">
          <div className="flex min-w-0 flex-col gap-4">
            <p className="m-0 text-sm">
              <a href={siteHref(ctx, `/courses/${v.course.slug}`)}>← {v.course.title}</a>
            </p>
            <Flash sp={sp} />
            <h1 className="gb-h2 m-0">{L.title}</h1>
            {!v.allowed ? (
              <div className="gb-card p-4" data-gb="locked">
                <p className="m-0">這個單元需要購買課程後才能觀看。</p>
                <a className="gb-btn mt-3" href={siteHref(ctx, `/courses/${v.course.slug}`)}>
                  查看課程
                </a>
              </div>
            ) : (
              <>
                {L.videoUrl && (
                  <div className="relative w-full overflow-hidden rounded-[var(--gb-radius)]" style={{ aspectRatio: "16 / 9" }}>
                    <iframe src={L.videoUrl} title={L.title} className="absolute inset-0 h-full w-full border-0" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" data-gb="lesson-video" />
                  </div>
                )}
                {L.bodyMd && <div className="gb-prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(L.bodyMd) }} />}
                {L.attachments.length > 0 && (
                  <ul className="m-0 text-sm" data-gb="attachments">
                    {L.attachments.map((a) => (
                      <li key={a.url}>
                        <a href={a.url} target="_blank" rel="noopener noreferrer">
                          {a.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {v.enrolled && (
                  <form method="post" action={`/s/${site.tenant.slug}/api/courses/progress`}>
                    <input type="hidden" name="course" value={v.course.slug} />
                    <input type="hidden" name="lesson" value={L.slug} />
                    <button className="gb-btn" type="submit" disabled={L.done} data-gb="mark-done">
                      {L.done ? "已完成" : "標記完成"}
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
          <nav aria-label="課程單元" className="gb-card h-fit p-4 text-sm">
            <ol className="m-0 flex flex-col gap-1 pl-5">
              {v.outline.map((o) => (
                <li key={o.slug} aria-current={o.slug === L.slug ? "page" : undefined}>
                  {v.enrolled || o.isPreview ? <a href={siteHref(ctx, `/learn/${v.course.slug}/${o.slug}`)}>{o.title}</a> : <span className="gb-muted">{o.title}</span>}
                  {o.done && " ✓"}
                </li>
              ))}
            </ol>
          </nav>
        </div>
      </section>
    </SiteShell>
  );
}
