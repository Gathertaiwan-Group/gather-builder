import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { canAccessCourse, publicCourses } from "@/lib/services/courses";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { Flash, payOptionsFor } from "@/components/site/ClassForms";
import { CourseView } from "@/modules/courses/sections";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; slug: string }>; searchParams: Promise<{ preview?: string; ok?: string; err?: string }> };

async function load(props: Props) {
  const [{ site: raw, slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "courses", sp.preview);
  if (!site) return null;
  const item = (await publicCourses(getStore(), site.tenant)).find((x) => x.course.slug === slug);
  return item ? { site, item, sp } : null;
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到課程" };
  return { title: `${r.item.course.title}｜${r.site.tenant.name}`, description: r.item.course.summary ?? undefined, openGraph: { title: r.item.course.title, images: r.item.course.cover_url ? [r.item.course.cover_url] : [] } };
}

export default async function CoursePage(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const { site, item, sp } = r;
  const ctx = makeRenderCtx(site, `/courses/${item.course.slug}`);
  const [member, pay] = await Promise.all([currentMember(site.tenant), payOptionsFor(site)]);
  const enrolled = await canAccessCourse(getStore(), site.tenant, item.course, member);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <p className="m-0 mb-4 text-sm">
            <a href={siteHref(ctx, "/courses")}>← 全部課程</a>
          </p>
          <Flash sp={sp} />
          <CourseView ctx={ctx} item={item} member={member} enrolled={enrolled} pay={pay} />
        </div>
      </section>
    </SiteShell>
  );
}
