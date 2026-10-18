import { findSectionType, validateSectionProps } from "@/modules/registry";
import { SECTION_RENDERERS } from "@/modules/renderers";
import type { RenderCtx } from "@/modules/render-types";
import type { Section } from "@/lib/content";
import { moduleActive } from "@/lib/site-loader";
import { applyTranslations } from "@/lib/i18n/translatable";
import { sectionTranslation } from "@/lib/i18n/render";

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
        // 多語：只覆蓋可翻譯的字串欄位（比對鍵、網址、數字不會被動到）；缺翻譯 fallback 預設語言
        const props = applyTranslations(v.props, sectionTranslation(ctx.site, ctx.path, s.id));
        return (
          <div key={s.id} id={s.type === "contact_form" ? undefined : s.id} data-section-type={s.type}>
            <Comp props={props} ctx={ctx} id={s.id} />
          </div>
        );
      })}
    </>
  );
}
