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

export const siteContentSchema = z
  .object({
    theme: themeSchema,
    pages: z.array(pageSchema).min(1).max(50),
    nav: z.array(navItemSchema).max(12),
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
