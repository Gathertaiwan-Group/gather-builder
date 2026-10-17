import { z } from "zod";
import type { ModuleManifest } from "../types";
import { imageUrl, optText, safeHref, text } from "@/lib/validators";

export const heroProps = z
  .object({
    heading: text(120),
    subheading: optText(400),
    ctaLabel: optText(40),
    ctaHref: safeHref.optional(),
    image: imageUrl.optional(),
    align: z.enum(["left", "center"]).default("center"),
  })
  .strict();

export const richTextProps = z.object({ heading: optText(120), markdown: text(20000) }).strict();

export const featuresProps = z
  .object({
    heading: optText(120),
    items: z.array(z.object({ title: text(80), body: text(600), icon: optText(4) }).strict()).min(1).max(12),
  })
  .strict();

export const galleryProps = z
  .object({
    heading: optText(120),
    images: z.array(z.object({ src: imageUrl, alt: text(200), caption: optText(200) }).strict()).min(1).max(40),
  })
  .strict();

export const testimonialsProps = z
  .object({
    heading: optText(120),
    items: z.array(z.object({ quote: text(800), author: text(80), role: optText(80) }).strict()).min(1).max(20),
  })
  .strict();

export const faqProps = z
  .object({
    heading: optText(120),
    items: z.array(z.object({ q: text(200), a: text(2000) }).strict()).min(1).max(40),
  })
  .strict();

export const ctaProps = z
  .object({ heading: text(120), body: optText(400), buttonLabel: text(40), buttonHref: safeHref })
  .strict();

export const manifest: ModuleManifest = {
  id: "sections-basic",
  name: "基本區塊",
  description: "首屏主視覺、圖文、特色、相簿、見證、常見問題、行動呼籲。形象站的基本積木。",
  category: "content",
  priceSetup: 3000,
  priceMonthly: 0,
  requires: ["core"],
  settingsSchema: z.object({}).strict(),
  sectionTypes: [
    { type: "hero", label: "首屏主視覺", description: "頁面最上方的大標題、副標與按鈕，可放背景圖。每頁通常一個，放第一個。", schema: heroProps, example: { heading: "歡迎光臨", subheading: "一句話說明你是誰、提供什麼", ctaLabel: "聯絡我們", ctaHref: "#contact", align: "center" } },
    { type: "rich_text", label: "圖文段落", description: "一段 Markdown 文字（標題、段落、清單、連結）。不支援原始 HTML。", schema: richTextProps, example: { heading: "關於我們", markdown: "我們是一間……" } },
    { type: "features", label: "特色/服務", description: "2–12 張卡片列出服務項目或賣點，每張有標題與說明，可加一個 emoji 圖示。", schema: featuresProps, example: { heading: "我們的服務", items: [{ title: "服務一", body: "說明", icon: "✨" }] } },
    { type: "gallery", label: "相簿", description: "一組圖片網格，點擊放大。圖片需為 https 網址。", schema: galleryProps, example: { heading: "作品花絮", images: [{ src: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=1200", alt: "風景" }] } },
    { type: "testimonials", label: "客戶見證", description: "客戶評價引言與署名。", schema: testimonialsProps, example: { heading: "客戶怎麼說", items: [{ quote: "非常推薦！", author: "王小姐" }] } },
    { type: "faq", label: "常見問題", description: "可展開的問答清單。", schema: faqProps, example: { heading: "常見問題", items: [{ q: "如何預約？", a: "填寫下方表單即可。" }] } },
    { type: "cta", label: "行動呼籲", description: "一條醒目的橫幅，引導訪客點一個按鈕（預約、購買、聯絡）。", schema: ctaProps, example: { heading: "準備好開始了嗎？", buttonLabel: "立即聯絡", buttonHref: "#contact" } },
  ],
  mcpTools: ["list_section_types", "add_section", "update_section", "remove_section", "move_section"],
};
