import type { SectionComponent } from "./render-types";
import { Cta, Faq, Features, Gallery, Hero, RichText, Testimonials } from "./sections-basic/sections";
import { PostsList } from "./blog/sections";
import { PortfolioGrid } from "./portfolio/sections";
import { ContactForm } from "./contact-form/sections";
import { LineButton } from "./line/sections";
import { AccountCta } from "./members/sections";
import { ProductDetail, ProductGrid } from "./shop/sections";
import { NewsletterSignup } from "./newsletter/sections";
import { EventDetail, EventsList } from "./events/sections";
import { BookingWidget } from "./booking/sections";
import { CourseDetail, CoursesList } from "./courses/sections";
import { LoyaltyTiers } from "./loyalty/sections";
import { TopupPlans } from "./stored-value/sections";
import { SearchBox } from "./search/sections";
import { PeopleGrid } from "./directory/sections";
import { DownloadsList } from "./downloads/sections";
import { CertificateLookup } from "./certificates/sections";
import { ProductReviews } from "./reviews/sections";
import { AnnouncementsBar, AnnouncementsList } from "./announcements/sections";
import { SubscriptionPlans } from "./subscriptions/sections";
import { GroupBuyDetail, GroupBuyList } from "./group-buy/sections";

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
  account_cta: AccountCta,
  product_grid: ProductGrid,
  product_detail: ProductDetail,
  newsletter_signup: NewsletterSignup,
  events_list: EventsList,
  event_detail: EventDetail,
  booking_widget: BookingWidget,
  courses_list: CoursesList,
  course_detail: CourseDetail,
  loyalty_tiers: LoyaltyTiers,
  topup_plans: TopupPlans,
  search_box: SearchBox,
  people_grid: PeopleGrid,
  downloads_list: DownloadsList,
  certificate_lookup: CertificateLookup,
  product_reviews: ProductReviews,
  announcements_bar: AnnouncementsBar,
  announcements_list: AnnouncementsList,
  subscription_plans: SubscriptionPlans,
  group_buy_list: GroupBuyList,
  group_buy_detail: GroupBuyDetail,
};
