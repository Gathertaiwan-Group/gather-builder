import type { SectionComponent } from "./render-types";
import { Cta, Faq, Features, Gallery, Hero, RichText, Testimonials } from "./sections-basic/sections";
import { PostsList } from "./blog/sections";
import { PortfolioGrid } from "./portfolio/sections";
import { ContactForm } from "./contact-form/sections";
import { LineButton } from "./line/sections";

/** 區塊類型 → 渲染元件。新增區塊類型時在這裡註冊（tests 會檢查與 manifest 一致）。 */
export const SECTION_RENDERERS: Record<string, SectionComponent> = {
  hero: Hero,
  rich_text: RichText,
  features: Features,
  gallery: Gallery,
  testimonials: Testimonials,
  faq: Faq,
  cta: Cta,
  posts_list: PostsList,
  portfolio_grid: PortfolioGrid,
  contact_form: ContactForm,
  line_button: LineButton,
};
