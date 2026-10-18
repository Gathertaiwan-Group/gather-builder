import type { z } from "zod";
import { moduleConfig } from "@/lib/site-loader";
import { siteHref, type SectionComponent } from "../render-types";
import type { searchBoxProps } from "./manifest";

export function SearchForm({ action, placeholder, q, previewToken }: { action: string; placeholder?: string; q?: string; previewToken?: string | null }) {
  const [path] = action.split("?");
  return (
    <form method="get" action={path} role="search" className="flex flex-wrap gap-2" data-gb="search-form">
      <input name="q" type="search" defaultValue={q} maxLength={60} required placeholder={placeholder ?? "輸入關鍵字"} aria-label="搜尋關鍵字" className="gb-input min-w-0 flex-1" />
      {previewToken && <input type="hidden" name="preview" value={previewToken} />}
      <button className="gb-btn" type="submit">
        搜尋
      </button>
    </form>
  );
}

export const SearchBox: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof searchBoxProps>;
  const s = moduleConfig<{ placeholder?: string }>(ctx.site, "search");
  return (
    <section className="gb-section">
      <div className="gb-container max-w-2xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <SearchForm action={siteHref(ctx, "/search")} placeholder={p.placeholder ?? s.placeholder} previewToken={ctx.site.mode === "preview" ? ctx.site.previewToken : null} />
      </div>
    </section>
  );
};
