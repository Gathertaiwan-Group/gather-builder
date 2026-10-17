import type { z } from "zod";
import { moduleConfig } from "@/lib/site-loader";
import type { RenderCtx, SectionComponent } from "../render-types";
import { lineSettings, type lineButtonProps } from "./manifest";
import { LineLink } from "./LineLink";

export function lineConfig(ctx: Pick<RenderCtx, "site">) {
  const r = lineSettings.safeParse(moduleConfig(ctx.site, "line"));
  return r.success ? r.data : null;
}

export const LineButton: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof lineButtonProps>;
  const cfg = lineConfig(ctx);
  if (!cfg) return null; // 模組尚未設定 lineUrl（pending_setup）
  return (
    <section className="gb-section">
      <div className="gb-container text-center">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {p.body && <p className="gb-muted mb-6 mt-0">{p.body}</p>}
        <LineLink href={cfg.lineUrl} slug={ctx.site.tenant.slug} path={ctx.path} placement="section" className="gb-btn gb-btn-line">
          {p.label ?? "加入 LINE 好友"}
        </LineLink>
      </div>
    </section>
  );
};

export function LineFloating({ ctx }: { ctx: RenderCtx }) {
  const cfg = lineConfig(ctx);
  if (!cfg || !cfg.floating) return null;
  return (
    <LineLink
      href={cfg.lineUrl}
      slug={ctx.site.tenant.slug}
      path={ctx.path}
      placement="floating"
      ariaLabel="LINE 聯絡我們"
      className="gb-btn gb-btn-line fixed bottom-4 right-4 z-40 shadow-lg"
    >
      {cfg.floatingLabel ?? "LINE 聯絡"}
    </LineLink>
  );
}
