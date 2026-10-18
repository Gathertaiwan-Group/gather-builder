import type { Metadata } from "next";
import { localizeNested, localizeRow } from "@/lib/services/i18n";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { offerFor, publicEventView } from "@/lib/services/events";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { Flash, payOptionsFor } from "@/components/site/ClassForms";
import { EventView } from "@/modules/events/sections";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; slug: string }>; searchParams: Promise<{ preview?: string; ok?: string; err?: string; offer?: string; t?: string }> };

async function load(props: Props) {
  const [{ site: raw, slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "events", sp.preview);
  if (!site) return null;
  const e = await localizeRow(getStore(), site, "event", await getStore().getEventBySlug(site.tenant.id, slug));
  // 草稿活動只在預覽模式看得到
  if (!e || (e.status !== "published" && site.mode !== "preview")) return null;
  return { site, e, sp };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到活動" };
  return { title: `${r.e.title}｜${r.site.tenant.name}`, description: r.e.summary ?? undefined, openGraph: { title: r.e.title, images: r.e.cover_url ? [r.e.cover_url] : [] }, ...(r.sp.offer ? { robots: { index: false }, referrer: "no-referrer" as const } : {}) };
}

export default async function EventPage(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const { site, e, sp } = r;
  const store = getStore();
  // 候補保留連結：路徑標成 /offer（SiteShell 不載入 GA，網址含一次性簽章）
  const ctx = makeRenderCtx(site, sp.offer ? `/events/${e.slug}/offer` : `/events/${e.slug}`);
  const [view, member, pay, offer] = await Promise.all([publicEventView(store, site.tenant, e), currentMember(site.tenant), payOptionsFor(site), sp.offer ? offerFor(store, site.tenant, sp.offer, sp.t) : Promise.resolve(null)]);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <p className="m-0 mb-4 text-sm">
            <a href={siteHref(ctx, "/events")}>← 全部活動</a>
          </p>
          <Flash sp={sp} />
          {sp.offer && !offer && <p className="gb-card mb-4 p-3 text-sm">這個候補保留連結已過期或無效。</p>}
          <EventView ctx={ctx} view={view} member={member} pay={pay} offer={offer} offerToken={sp.t} />
        </div>
      </section>
    </SiteShell>
  );
}
