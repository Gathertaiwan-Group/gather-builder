import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { moduleConfig } from "@/lib/site-loader";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { CertLookup } from "@/modules/certificates/CertLookup";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "證照查詢", referrer: "no-referrer" };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string }> };

export default async function VerifyPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "certificates", sp.preview);
  if (!site) notFound();
  const cfg = moduleConfig<{ title?: string; intro?: string }>(site, "certificates");
  return (
    <SiteShell ctx={makeRenderCtx(site, "/verify")}>
      <section className="gb-section">
        <div className="gb-container max-w-2xl">
          <h1 className="gb-h2">{cfg.title ?? "證照查詢"}</h1>
          <p className="gb-muted">{cfg.intro ?? "請輸入證號，或姓名＋生日查詢。查詢結果不會顯示生日，姓名部分遮罩。"}</p>
          <CertLookup endpoint={`/api/s/${site.tenant.slug}/verify`} />
        </div>
      </section>
    </SiteShell>
  );
}
