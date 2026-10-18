import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const directorySettings = z
  .object({
    /** 名錄頁標題（預設「成員」） */
    listTitle: optText(60),
  })
  .strict();

export const peopleGridProps = z
  .object({
    heading: optText(120),
    /** 只顯示某一分類（不填＝全部） */
    category: optText(40),
    limit: z.number().int().min(1).max(60).default(12),
    /** 顯示分類篩選按鈕 */
    showFilter: z.boolean().default(true),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "directory",
  name: "人員名錄",
  description:
    "成員／師資／理監事／醫師等人員名錄：姓名、職稱、分類、照片、簡介（Markdown）、聯絡方式（預設不公開，可選公開）。分類篩選、個人頁 /people/<slug>、區塊 people_grid。上架比照 publish＋confirm。",
  category: "content",
  priceSetup: 6000,
  priceMonthly: 300,
  requires: ["core"],
  settingsSchema: directorySettings,
  sectionTypes: [
    {
      type: "people_grid",
      label: "人員名錄",
      description: "人員卡片（照片、姓名、職稱），可依分類篩選，點進個人頁。category 只顯示某一分類。",
      schema: peopleGridProps,
      example: { heading: "師資介紹", limit: 12, showFilter: true },
    },
  ],
  mcpTools: ["create_person", "update_person", "list_people"],
};
