import { z } from "zod";
import { DEFAULT_PRESET, themeSchema } from "./themes";
import { imageUrl, optText, pagePath, safeHref, text } from "./validators";

/**
 * 網站內容（草稿與發布快照共用同一個形狀）。
 * agent 只能透過服務函式改這份 JSON；這裡沒有任何可執行程式碼。
 */
export const sectionSchema = z
  .object({
    id: z.string().regex(/^s_[a-z0-9]{6,16}$/),
    type: z.string().min(1).max(40),
    props: z.record(z.string(), z.unknown()),
  })
  .strict();

export const seoSchema = z
  .object({
    title: optText(120),
    description: optText(300),
    ogImage: imageUrl.optional(),
  })
  .strict();

export const pageSchema = z
  .object({
    path: pagePath,
    title: text(120),
    seo: seoSchema.default({}),
    sections: z.array(sectionSchema).max(60),
  })
  .strict();

export const navItemSchema = z.object({ label: text(40), href: safeHref }).strict();

/** 多語翻譯（i18n 模組）：跟著草稿／發布走，publish_site 才上線。t＝譯文、ai＝AI 產生（店主改過就變 false） */
export const trEntry = z.object({ t: z.string().max(20_000), ai: z.boolean().optional() }).strict();
export const pageTranslationSchema = z
  .object({
    title: trEntry.optional(),
    seoTitle: trEntry.optional(),
    seoDescription: trEntry.optional(),
    /** sectionId → 欄位路徑 → 譯文 */
    sections: z.record(z.string().regex(/^s_[a-z0-9]{6,16}$/), z.record(z.string().max(200), trEntry)).default({}),
  })
  .strict();
export const langTranslationSchema = z
  .object({
    pages: z.record(z.string().max(200), pageTranslationSchema).default({}),
    /** 導覽列索引 → 譯文 */
    nav: z.record(z.string().regex(/^\d{1,2}$/), trEntry).default({}),
  })
  .strict();
export type LangTranslation = z.infer<typeof langTranslationSchema>;

export const siteContentSchema = z
  .object({
    theme: themeSchema,
    pages: z.array(pageSchema).min(1).max(50),
    nav: z.array(navItemSchema).max(12),
    /** 模組設定（configure_module 寫進草稿，發布後才對外生效） */
    moduleSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    /** i18n：語言代碼 → 翻譯（沒有時不出現這個 key，避免舊網站的快照被誤判為有變更） */
    translations: z.record(z.string().regex(/^[a-z]{2}(-[a-z]{2})?$/), langTranslationSchema).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const p of c.pages) {
      if (seen.has(p.path)) ctx.addIssue({ code: "custom", message: `頁面路徑重複：${p.path}` });
      seen.add(p.path);
    }
    if (!seen.has("/")) ctx.addIssue({ code: "custom", message: "必須有首頁 /" });
  });

export type Section = z.infer<typeof sectionSchema>;
export type Page = z.infer<typeof pageSchema>;
export type NavItem = z.infer<typeof navItemSchema>;
export type SiteContent = z.infer<typeof siteContentSchema>;

export function defaultContent(siteName: string, preset = DEFAULT_PRESET): SiteContent {
  return {
    theme: { preset, overrides: {} },
    pages: [
      {
        path: "/",
        title: siteName,
        seo: { title: siteName },
        sections: [],
      },
    ],
    nav: [{ label: "首頁", href: "/" }],
    moduleSettings: {},
  };
}

export function findPage(content: SiteContent, path: string): Page | undefined {
  const norm = normalizePath(path);
  return content.pages.find((p) => p.path === norm);
}

export function normalizePath(path: string): string {
  if (!path) return "/";
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.toLowerCase();
}
