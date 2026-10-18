import type { z } from "zod";
import { getStore } from "@/lib/store";
import { publicPeople } from "@/lib/services/directory";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { peopleGridProps } from "./manifest";

type P = Awaited<ReturnType<typeof publicPeople>>[number];

export function PeopleCards({ ctx, people }: { ctx: RenderCtx; people: P[] }) {
  if (!people.length) return <p className="gb-muted">名單準備中。</p>;
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0 md:grid-cols-4" data-gb="people">
      {people.map((p) => (
        <li key={p.id} className="gb-card overflow-hidden">
          <a href={siteHref(ctx, `/people/${p.slug}`)} className="block no-underline" style={{ color: "var(--gb-text)" }}>
            {p.photo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.photo_url} alt={p.name} loading="lazy" className="aspect-square w-full object-cover" />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center text-3xl" style={{ background: "var(--gb-surface)" }} aria-hidden>
                {[...p.name][0]}
              </div>
            )}
            <div className="p-3">
              <strong className="block">{p.name}</strong>
              {p.title && <span className="gb-muted text-sm">{p.title}</span>}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function CategoryFilter({ ctx, categories, active, base }: { ctx: RenderCtx; categories: string[]; active: string | null; base: string }) {
  if (categories.length < 2) return null;
  const href = (c: string | null) => {
    const u = siteHref(ctx, base);
    return c ? `${u}${u.includes("?") ? "&" : "?"}category=${encodeURIComponent(c)}` : u;
  };
  return (
    <nav aria-label="分類" className="mb-5 flex flex-wrap gap-2 text-sm" data-gb="people-filter">
      <a href={href(null)} className="gb-card px-3 py-1 no-underline" aria-current={!active ? "true" : undefined} style={{ color: "var(--gb-text)", fontWeight: !active ? 700 : 400 }}>
        全部
      </a>
      {categories.map((c) => (
        <a key={c} href={href(c)} className="gb-card px-3 py-1 no-underline" aria-current={active === c ? "true" : undefined} style={{ color: "var(--gb-text)", fontWeight: active === c ? 700 : 400 }}>
          {c}
        </a>
      ))}
    </nav>
  );
}

export const PeopleGrid: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof peopleGridProps>;
  const all = await publicPeople(getStore(), ctx.site.tenant);
  const people = (p.category ? all.filter((x) => x.category === p.category) : all).slice(0, p.limit);
  const cats = [...new Set(all.map((x) => x.category).filter((c): c is string => !!c))];
  return (
    <section className="gb-section">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {p.showFilter && !p.category && <CategoryFilter ctx={ctx} categories={cats} active={null} base="/people" />}
        <PeopleCards ctx={ctx} people={people} />
      </div>
    </section>
  );
};
