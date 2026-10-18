import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { getStore } from "@/lib/store";
import { publicPerson } from "@/lib/services/directory";
import { renderMarkdown } from "@/lib/markdown";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; slug: string }>; searchParams: Promise<{ preview?: string }> };

async function load(props: Props) {
  const [{ site: raw, slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "directory", sp.preview);
  if (!site) return null;
  const p = await getStore().getPersonBySlug(site.tenant.id, slug);
  if (!p || (p.status !== "published" && site.mode !== "preview")) return null;
  return { site, person: publicPerson(p) };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到頁面" };
  return { title: `${r.person.name}${r.person.title ? `｜${r.person.title}` : ""}｜${r.site.tenant.name}`, description: r.person.bio_md.slice(0, 150) || undefined };
}

export default async function PersonPage(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const { site, person: p } = r;
  const ctx = makeRenderCtx(site, `/people/${p.slug}`);
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container flex max-w-3xl flex-col gap-6 md:flex-row">
          {p.photo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.photo_url} alt={p.name} className="w-full max-w-[16rem] self-start rounded object-cover" />
          )}
          <div className="min-w-0 flex-1" data-gb="person">
            <a href={siteHref(ctx, "/people")} className="text-sm">
              ← 全部
            </a>
            <h1 className="gb-h2 mb-1 mt-2">{p.name}</h1>
            {(p.title || p.category) && <p className="gb-muted m-0">{[p.title, p.category].filter(Boolean).join(" · ")}</p>}
            {p.bio_md && <div className="gb-prose mt-4" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.bio_md) }} />}
            {(p.email || p.phone || p.website) && (
              <ul className="gb-card mt-4 flex list-none flex-col gap-1 p-4 text-sm" data-gb="person-contact">
                {p.email && <li>Email：<a href={`mailto:${p.email}`}>{p.email}</a></li>}
                {p.phone && <li>電話：<a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}>{p.phone}</a></li>}
                {p.website && <li>網站：<a href={p.website} target="_blank" rel="noopener noreferrer">{p.website}</a></li>}
              </ul>
            )}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
