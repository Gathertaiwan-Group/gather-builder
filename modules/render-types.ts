import type { LoadedSite } from "@/lib/site-loader";

export interface RenderCtx {
  site: LoadedSite;
  /** /s/<slug> */
  basePath: string;
  /** 目前頁面的站內路徑，例如 /about */
  path: string;
}

/** 站內連結 → 實際網址（預覽模式保留 preview 參數）；外部連結原樣回傳 */
export function siteHref(ctx: Pick<RenderCtx, "site" | "basePath">, href: string): string {
  if (!href.startsWith("/")) return href;
  const [p, hash] = href.split("#");
  const url = `${ctx.basePath}${p === "/" ? "" : p}`;
  const q = ctx.site.mode === "preview" && ctx.site.previewToken ? `?preview=${encodeURIComponent(ctx.site.previewToken)}` : "";
  return `${url || "/"}${q}${hash ? `#${hash}` : ""}`;
}

export type SectionComponent = (args: { props: Record<string, unknown>; ctx: RenderCtx; id: string }) => React.ReactNode | Promise<React.ReactNode>;
