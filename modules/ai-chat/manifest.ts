import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

/** AI 客服設定（configure_module，進草稿、發布後生效）。知識內容＝這些設定＋已發布網站內容＋已上架商品，不寫死任何店家資料。 */
export const aiChatSettings = z
  .object({
    /** 客服名稱（顯示在視窗標題） */
    assistantName: optText(30),
    /** 開場白 */
    greeting: optText(200),
    /** 額外知識（營業時間、退換貨規則、常見問題…；純文字） */
    extraKnowledge: optText(6000),
    /** 每個 IP 每天最多幾則（預設 30） */
    perIpDailyLimit: z.number().int().min(1).max(500).optional(),
    /** 整個網站每天最多幾則（預設 300） */
    dailyLimit: z.number().int().min(1).max(20000).optional(),
    /** false = 不從對話萃取聯絡資料寫進詢問收件匣 */
    collectLeads: z.boolean().optional(),
  })
  .strict();
export type AiChatSettings = z.output<typeof aiChatSettings>;

export const manifest: ModuleManifest = {
  id: "ai-chat",
  name: "AI 客服",
  description:
    "網站右下角 AI 客服（Gemini）。只根據這個網站已發布的內容、已上架商品與設定裡的額外知識回答，價格只能引用商品資料；訪客留下的聯絡方式自動寫進詢問收件匣。每 IP 每日、每站每日上限（DB 原子計數）。平台沒設 GEMINI_API_KEY 時為 pending_setup、前台不顯示。",
  category: "engagement",
  priceSetup: 5000,
  priceMonthly: 800,
  requires: ["core"],
  settingsSchema: aiChatSettings,
  sectionTypes: [],
  adminPages: [{ path: "ai-chat", label: "AI 客服" }],
  mcpTools: ["list_ai_chats"],
};
