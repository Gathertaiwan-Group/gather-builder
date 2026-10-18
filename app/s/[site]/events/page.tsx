import type { Metadata } from "next";
import { localizeNested, localizeRow } from "@/lib/services/i18n";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { publicEvents } from "@/lib/services/events";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { EventCards } from "@/modules/events/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "events", sp.preview);
  return { title: site ? `活動｜${site.tenant.name}` : "找不到頁面" };
}

export default async function EventsIndex(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "events", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/events");
  const items = await localizeNested(getStore(), site, "event", await publicEvents(getStore(), site.tenant, 60), "event");
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">活動</h1>
          {items.length === 0 ? <p className="gb-muted">近期沒有活動。</p> : <EventCards ctx={ctx} items={items} />}
        </div>
      </section>
    </SiteShell>
  );
}
