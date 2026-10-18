import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { moduleConfig } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { visibleAnnouncements } from "@/lib/services/announcements";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AnnouncementCards } from "@/modules/announcements/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string; ok?: string; err?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "announcements", sp.preview);
  return { title: site ? `${moduleConfig<{ listTitle?: string }>(site, "announcements").listTitle ?? "公告"}｜${site.tenant.name}` : "找不到頁面" };
}

export default async function AnnouncementsPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "announcements", sp.preview);
  if (!site) notFound();
  const member = await currentMember(site.tenant);
  const items = await visibleAnnouncements(getStore(), site.tenant, member);
  return (
    <SiteShell ctx={makeRenderCtx(site, "/announcements")}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <h1 className="gb-h2">{moduleConfig<{ listTitle?: string }>(site, "announcements").listTitle ?? "公告"}</h1>
          {sp.ok && <p className="gb-card mb-4 p-3 text-sm" data-gb="ok">{sp.ok}</p>}
          {sp.err && <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">{sp.err}</p>}
          <AnnouncementCards items={items} />
        </div>
      </section>
    </SiteShell>
  );
}
