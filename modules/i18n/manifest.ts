import { z } from "zod";
import type { ModuleManifest } from "../types";
import { LANG_CODES } from "@/lib/i18n/langs";

/** 多語設定（configure_module，進草稿、發布後生效） */
export const i18nSettings = z
  .object({
    /** 除了預設 zh-TW 以外開放的語言（網址 /s/<slug>/<lang>/…） */
    languages: z.array(z.enum(LANG_CODES as [string, ...string[]])).max(9).default([]).refine((v) => new Set(v).size === v.length, { message: "語言重複" }),
    /** AI 翻譯每天上限（次；每次翻一個頁面或一筆內容，預設 50） */
    aiDailyLimit: z.number().int().min(1).max(1000).optional(),
    /** 給 AI 的翻譯指引（品牌名、專有名詞不翻等） */
    glossary: z.string().trim().max(2000).optional(),
  })
  .strict();
export type I18nSettings = z.output<typeof i18nSettings>;

export const manifest: ModuleManifest = {
  id: "i18n",
  name: "多語＋AI 翻譯",
  description:
    `網站多語：預設繁體中文（不加前綴），可加 ${LANG_CODES.join("、")}，網址 /s/<slug>/<lang>/…（所有模組頁面都吃得到）、自動 hreflang、html lang、語言切換。頁面區塊的文字欄位、頁面標題與 SEO、導覽、文章、商品、活動、課程的標題與內容都能翻譯；缺翻譯自動顯示中文；slug、價格、id 等比對鍵不翻譯。AI 翻譯（Gemini）一律進草稿、標記「AI 翻譯」，店主可修改，發布才上線；每租戶每日上限。`,
  category: "content",
  priceSetup: 15000,
  priceMonthly: 800,
  requires: ["core"],
  settingsSchema: i18nSettings,
  sectionTypes: [],
  adminPages: [{ path: "i18n", label: "多語" }],
  mcpTools: ["translate_content", "set_translation", "list_translations", "publish_translations"],
};
