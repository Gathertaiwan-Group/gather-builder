import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { publicServices } from "@/lib/services/booking";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { Flash, payOptionsFor } from "@/components/site/ClassForms";
import { BookingFlow, ServiceCards } from "@/modules/booking/sections";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string; service?: string; from?: string; slot?: string; ok?: string; err?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "booking", sp.preview);
  return { title: site ? `線上預約｜${site.tenant.name}` : "找不到頁面" };
}

export default async function BookPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "booking", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/book");
  const store = getStore();
  const services = await publicServices(store, site.tenant);
  const service = sp.service ? services.find((s) => s.slug === sp.service) ?? null : services.length === 1 ? services[0]! : null;
  const [member, pay] = await Promise.all([currentMember(site.tenant), payOptionsFor(site)]);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <Flash sp={sp} />
          {service ? (
            <>
              {services.length > 1 && (
                <p className="m-0 mb-4 text-sm">
                  <a href={siteHref(ctx, "/book")}>← 全部服務</a>
                </p>
              )}
              <BookingFlow ctx={ctx} service={service} from={sp.from} slot={sp.slot} member={member} pay={pay} />
            </>
          ) : (
            <>
              <h1 className="gb-h2">線上預約</h1>
              {services.length === 0 ? <p className="gb-muted">目前沒有開放預約的服務。</p> : <ServiceCards ctx={ctx} services={services} />}
            </>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
