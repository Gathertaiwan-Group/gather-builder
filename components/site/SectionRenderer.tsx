import { findSectionType, validateSectionProps } from "@/modules/registry";
import { SECTION_RENDERERS } from "@/modules/renderers";
import type { RenderCtx } from "@/modules/render-types";
import type { Section } from "@/lib/content";
import { moduleActive } from "@/lib/site-loader";

/** JSON 驅動的區塊渲染：模組未啟用或 props 不合法的區塊直接略過（不讓整頁壞掉） */
export function SectionList({ sections, ctx }: { sections: Section[]; ctx: RenderCtx }) {
  return (
    <>
      {sections.map((s) => {
        const found = findSectionType(s.type);
        const Comp = SECTION_RENDERERS[s.type];
        if (!found || !Comp || !moduleActive(ctx.site, found.module.id)) return null;
        const v = validateSectionProps(s.type, s.props);
        if (!v.ok) return null;
        return (
          <div key={s.id} id={s.type === "contact_form" ? undefined : s.id} data-section-type={s.type}>
            <Comp props={v.props} ctx={ctx} id={s.id} />
          </div>
        );
      })}
    </>
  );
}
