import type { z } from "zod";
import { getStore } from "@/lib/store";
import { LightboxGrid } from "@/components/site/Lightbox";
import type { SectionComponent } from "../render-types";
import type { portfolioGridProps } from "./manifest";

export const PortfolioGrid: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof portfolioGridProps>;
  const items = await getStore().listPortfolio(ctx.site.tenant.id, { status: "published", tag: p.tag });
  return (
    <section className="gb-section">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {items.length === 0 ? (
          <p className="gb-muted">作品整理中。</p>
        ) : (
          <LightboxGrid
            columns={p.columns}
            items={items.map((it) => ({ src: it.image_url, alt: it.title, title: it.title, caption: it.description ?? undefined, href: it.link_url ?? undefined }))}
          />
        )}
      </div>
    </section>
  );
};
