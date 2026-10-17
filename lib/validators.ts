import { z } from "zod";

// 錯誤訊息用繁體中文（agent 與後台都會直接看到）
z.config(z.locales.zhTW());

/** 連結：允許 http(s)、站內相對路徑、錨點、mailto、tel。擋 javascript: 等。 */
export const safeHref = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^(https?:\/\/|\/(?!\/)|#|mailto:|tel:)/i.test(v), {
    message: "連結必須是 https://、http://、/站內路徑、#錨點、mailto: 或 tel:",
  });

/** 圖片網址：https:// 或站內 / 路徑 */
export const imageUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^(https:\/\/|\/(?!\/))/i.test(v), { message: "圖片網址必須是 https:// 或 / 開頭" });

export const text = (max: number) => z.string().trim().min(1).max(max);
export const optText = (max: number) => z.string().trim().max(max).optional();

/** 網站內頁路徑：/、/about、/services/web */
export const pagePath = z
  .string()
  .trim()
  .regex(/^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?$/, {
    message: "頁面路徑需為 / 開頭的小寫英數與連字號，例如 /about 或 /services/web",
  })
  .refine((p) => p !== "/blog" && !p.startsWith("/blog/"), { message: "/blog 由部落格模組保留" });

export const siteSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, { message: "slug 需為 3–40 字的小寫英數與連字號" });

export const postSlug = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/, { message: "文章 slug 需為小寫英數與連字號（最長 80）" });

export const cssColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, { message: "顏色需為 #RGB 或 #RRGGBB" });

/** 字體堆疊：只允許字型名、引號、逗號、空白、連字號，避免 CSS 注入 */
export const fontStack = z
  .string()
  .trim()
  .max(200)
  .regex(/^[A-Za-z0-9 ,'"\-一-鿿]+$/, { message: "字體只能包含字型名稱、逗號與引號" });

export const cssLength = z
  .string()
  .trim()
  .regex(/^(?:0|\d{1,3}(?:\.\d+)?(?:px|rem|em))$/, { message: "長度需為 0、px、rem 或 em，例如 12px" });
