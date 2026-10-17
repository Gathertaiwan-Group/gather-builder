#!/usr/bin/env node
// 建一個展示所有區塊的示範站（標記 test）：node --env-file=.env.local scripts/seed-demo.mjs [baseUrl] [slug]
import { connect } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3100";
const slug = args.find((a) => !a.startsWith("http")) ?? `demo-${Date.now().toString(36)}`;
const img = (id) => `https://images.unsplash.com/${id}?w=1200&q=70&auto=format&fit=crop`;

const p = await connect(base, process.env.GB_PLATFORM_TOKEN);
const s = await p.call("create_site", { slug, name: "山嵐咖啡", modules: ["sections-basic", "blog", "portfolio", "contact-form", "line"], themePreset: "warm-terroir", test: true });
if (s.__error) throw new Error(s.__error);
await p.close();
const c = await connect(base, s.token);
const must = async (tool, a) => {
  const r = await c.call(tool, a);
  if (r.__error) throw new Error(`${tool}: ${r.__error}`);
  return r;
};
const home = await must("get_page", { path: "/" });
await must("update_section", { path: "/", sectionId: home.sections[0].id, props: { heading: "山嵐咖啡｜一杯慢慢來的日常", subheading: "嚴選台灣在地咖啡豆，手沖、烘焙課程與選物。週二至週日 10:00–18:00。", ctaLabel: "預約烘豆課", ctaHref: "#contact", image: img("photo-1495474472287-4d71bcdd2085") } });
await must("configure_module", { moduleId: "line", config: { lineUrl: "https://lin.ee/example", floating: true, floatingLabel: "LINE 詢問" } });
await must("add_section", { path: "/", type: "features", props: { heading: "我們提供", items: [{ title: "在地單品豆", body: "阿里山、古坑、東山的小農批次，每週新鮮烘焙。", icon: "☕" }, { title: "手沖課程", body: "從研磨、水溫到萃取，一次學會在家沖出好咖啡。", icon: "📚" }, { title: "企業禮盒", body: "客製濾掛與禮盒，附品牌卡片與報價單。", icon: "🎁" }] } });
await must("add_section", { path: "/", type: "rich_text", props: { heading: "關於山嵐", markdown: "我們相信**好咖啡不需要趕**。\n\n- 每批豆子都有產地與處理法紀錄\n- 烘焙度從淺到中深，依豆子個性調整\n\n[看看最新消息](/blog)" } });
await must("add_section", { path: "/", type: "portfolio_grid", props: { heading: "合作案例", columns: 3 } });
for (const [t, id] of [["企業中秋禮盒", "photo-1509042239860-f550ce710b93"], ["市集快閃攤", "photo-1442512595331-e89e73853f31"], ["品牌聯名濾掛", "photo-1497935586351-b67a49e012bf"]]) {
  await must("create_portfolio_item", { title: t, description: `${t}：從企劃到出貨一條龍。`, imageUrl: img(id), tags: ["案例"] });
}
await must("add_section", { path: "/", type: "testimonials", props: { heading: "客人怎麼說", items: [{ quote: "第一次上手沖課就成功沖出喜歡的味道，老師很有耐心。", author: "林小姐", role: "課程學員" }, { quote: "禮盒質感很好，同事都問在哪裡買的。", author: "陳經理", role: "企業客戶" }] } });
await must("add_section", { path: "/", type: "posts_list", props: { heading: "最新消息", limit: 3 } });
await must("add_section", { path: "/", type: "faq", props: { heading: "常見問題", items: [{ q: "課程需要自備器材嗎？", a: "不用，教室提供全套器材，結束後可優惠購買。" }, { q: "可以開發票嗎？", a: "可以，結帳時告知統編即可。" }] } });
await must("add_section", { path: "/", type: "line_button", props: { heading: "加入 LINE 好友", body: "新豆上架、課程開放第一時間通知", label: "加入好友" } });
await must("add_section", { path: "/", type: "cta", props: { heading: "想訂企業禮盒？", body: "告訴我們數量與預算，三個工作天內回覆報價。", buttonLabel: "填寫需求", buttonHref: "#contact" } });
await must("add_section", { path: "/", type: "contact_form", props: { heading: "聯絡我們", intro: "課程預約、禮盒報價都可以在這裡留言。" } });
await must("upsert_page", { path: "/about", title: "關於我們", addToNav: true, seo: { description: "山嵐咖啡的故事" } });
await must("add_section", { path: "/about", type: "gallery", props: { heading: "店內一隅", images: [{ src: img("photo-1501339847302-ac426a4a7cbb"), alt: "吧台" }, { src: img("photo-1453614512568-c4024d13c247"), alt: "座位區" }, { src: img("photo-1511920170033-f8396924c348"), alt: "咖啡豆" }] } });
await must("update_nav", { items: [{ label: "首頁", href: "/" }, { label: "關於我們", href: "/about" }, { label: "最新消息", href: "/blog" }, { label: "聯絡", href: "/#contact" }] });
await must("create_post", { slug: "autumn-beans", title: "秋季新豆上架：古坑日曬", excerpt: "帶有熟成水果與黑糖尾韻。", bodyMd: "今年秋天的古坑日曬批次終於到貨。\n\n## 風味\n\n熟成水果、黑糖、可可。", status: "published" });
await must("create_post", { slug: "pourover-class-nov", title: "十一月手沖課程開放報名", excerpt: "每週六下午，小班制 6 人。", bodyMd: "名額有限，歡迎用下方表單預約。", status: "published" });
const pub = await must("publish_site", { confirm: true, note: "示範站初版" });
console.log(JSON.stringify({ slug, revision: pub.revision, url: pub.url }));
