import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { confirmSubscription } from "@/lib/services/newsletter";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "確認訂閱", robots: { index: false }, referrer: "no-referrer" };

export default async function ConfirmPage(props: { params: Promise<{ site: string }>; searchParams: Promise<{ token?: string }> }) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "newsletter");
  if (!site) notFound();
  const r = await confirmSubscription(getStore(), site.tenant, sp.token);
  return (
    <SiteShell ctx={makeRenderCtx(site, "/newsletter/confirm")}>
      <section className="gb-section">
        <div className="gb-container max-w-xl">
          <h1 className="gb-h2">電子報訂閱</h1>
          <p className="gb-card p-4" data-gb="newsletter-confirm" data-ok={r.ok ? "1" : "0"}>
            {r.message}
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
