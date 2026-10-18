import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { moduleConfig } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { publicPeople } from "@/lib/services/directory";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { CategoryFilter, PeopleCards } from "@/modules/directory/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ preview?: string; category?: string }> };

export async function generateMetadata(props: Props): Promise<Metadata> {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "directory", sp.preview);
  return { title: site ? `${moduleConfig<{ listTitle?: string }>(site, "directory").listTitle ?? "成員"}｜${site.tenant.name}` : "找不到頁面" };
}

export default async function PeopleIndex(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "directory", sp.preview);
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/people");
  const all = await publicPeople(getStore(), site.tenant);
  const cat = typeof sp.category === "string" ? sp.category.slice(0, 40) : null;
  const people = cat ? all.filter((p) => p.category === cat) : all;
  const cats = [...new Set(all.map((x) => x.category).filter((c): c is string => !!c))];
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container">
          <h1 className="gb-h2">{moduleConfig<{ listTitle?: string }>(site, "directory").listTitle ?? "成員"}</h1>
          <CategoryFilter ctx={ctx} categories={cats} active={cat} base="/people" />
          <PeopleCards ctx={ctx} people={people} />
        </div>
      </section>
    </SiteShell>
  );
}
