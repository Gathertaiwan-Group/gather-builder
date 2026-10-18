import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { currentMember } from "@/lib/site-request";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { TopupPlanCards } from "@/modules/stored-value/sections";
import { MemberWallet } from "@/components/site/MemberCredits";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string; err?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "stored-value", sp.preview);
  return { title: site ? `儲值｜${site.tenant.name}` : "找不到頁面" };
}

export default async function WalletPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "stored-value", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/wallet");
  const member = await currentMember(site.tenant);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">儲值</h1>
          {sp.err && (
            <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">
              {sp.err}
            </p>
          )}
          {member && <MemberWallet tenant={site.tenant} member={member} />}
          <TopupPlanCards ctx={ctx} />
        </div>
      </section>
    </SiteShell>
  );
}
