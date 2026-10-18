import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { moduleConfig } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { publicDocuments } from "@/lib/services/downloads";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { DocumentList } from "@/modules/downloads/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string; err?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "downloads", sp.preview);
  return { title: site ? `${moduleConfig<{ listTitle?: string }>(site, "downloads").listTitle ?? "文件下載"}｜${site.tenant.name}` : "找不到頁面" };
}

export default async function DownloadsIndex(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "downloads", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/downloads");
  const docs = await publicDocuments(getStore(), site.tenant);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <h1 className="gb-h2">{moduleConfig<{ listTitle?: string }>(site, "downloads").listTitle ?? "文件下載"}</h1>
          {sp.err && (
            <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">
              {sp.err}
            </p>
          )}
          <DocumentList ctx={ctx} docs={docs} />
        </div>
      </section>
    </SiteShell>
  );
}
