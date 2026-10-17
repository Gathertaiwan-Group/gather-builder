import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

/** 設定不完整（沒有 lineUrl）時模組狀態為 pending_setup，按鈕不顯示 */
export const lineSettings = z
  .object({
    lineUrl: z
      .string()
      .trim()
      .regex(/^https:\/\/(line\.me|lin\.ee|page\.line\.me)\//, { message: "LINE 連結需為 https://line.me/、https://lin.ee/ 或 https://page.line.me/ 開頭" }),
    floating: z.boolean().default(true),
    floatingLabel: optText(20),
  })
  .strict();

export const lineButtonProps = z
  .object({
    heading: optText(120),
    body: optText(300),
    label: optText(30),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "line",
  name: "LINE 按鈕",
  description: "LINE 加好友按鈕區塊與全站浮動按鈕，點擊次數會記錄。需先設定 lineUrl。",
  category: "engagement",
  priceSetup: 1500,
  priceMonthly: 0,
  requires: ["core"],
  settingsSchema: lineSettings,
  sectionTypes: [
    { type: "line_button", label: "LINE 加好友", description: "一個 LINE 綠色按鈕與說明文字，連到模組設定的 lineUrl。", schema: lineButtonProps, example: { heading: "加入 LINE 好友", body: "即時回覆、優惠搶先知", label: "加入好友" } },
  ],
  mcpTools: [],
};
