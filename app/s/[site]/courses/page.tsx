import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { publicCourses } from "@/lib/services/courses";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { CourseCards } from "@/modules/courses/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "courses", sp.preview);
  return { title: site ? `線上課程｜${site.tenant.name}` : "找不到頁面" };
}

export default async function CoursesIndex(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "courses", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/courses");
  const items = await publicCourses(getStore(), site.tenant);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">線上課程</h1>
          {items.length === 0 ? <p className="gb-muted">課程準備中。</p> : <CourseCards ctx={ctx} items={items} />}
        </div>
      </section>
    </SiteShell>
  );
}
