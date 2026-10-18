import type { z } from "zod";
import { getStore } from "@/lib/store";
import { publicDocuments } from "@/lib/services/downloads";
import type { DocumentRow } from "@/lib/store/types";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import type { downloadsListProps } from "./manifest";

const size = (n: number | null) => (n === null ? "" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 下載連結指向 /s/<slug>/downloads/<id>（伺服器檢查權限後才給 60 秒簽名網址），不直接放 Storage 網址 */
export function DocumentList({ ctx, docs }: { ctx: RenderCtx; docs: DocumentRow[] }) {
  if (!docs.length) return <p className="gb-muted">目前沒有文件。</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0" data-gb="documents">
      {docs.map((d) => (
        <li key={d.id} id={`doc-${d.id}`} className="gb-card flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="min-w-0 flex-1">
            <strong className="block">{d.title}</strong>
            <span className="gb-muted text-sm">
              {[d.category, d.file_name?.split(".").pop()?.toUpperCase(), size(d.size_bytes)].filter(Boolean).join(" · ")}
              {d.visibility === "members" && " · 會員專屬"}
            </span>
            {d.description && <span className="gb-muted mt-1 block text-sm">{d.description}</span>}
          </span>
          <a className="gb-btn" href={siteHref(ctx, `/downloads/${d.id}`)} rel="nofollow" data-gb="download-link">
            {d.visibility === "members" ? "會員下載" : "下載"}
          </a>
        </li>
      ))}
    </ul>
  );
}

export const DownloadsList: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof downloadsListProps>;
  const all = await publicDocuments(getStore(), ctx.site.tenant);
  const docs = (p.category ? all.filter((d) => d.category === p.category) : all).slice(0, p.limit);
  return (
    <section className="gb-section">
      <div className="gb-container max-w-3xl">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        <DocumentList ctx={ctx} docs={docs} />
      </div>
    </section>
  );
};
