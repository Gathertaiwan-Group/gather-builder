import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const announcementsSettings = z.object({ listTitle: optText(60) }).strict();

export const announcementsBarProps = z
  .object({
    /** 顯示幾則（置頂優先） */
    limit: z.number().int().min(1).max(5).default(1),
  })
  .strict();

export const announcementsListProps = z
  .object({
    heading: optText(120),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "announcements",
  name: "公告",
  description:
    "公告（標題、內容 Markdown、置頂、上下架時間、對象：所有訪客或僅會員）。可設「必讀確認」：會員登入後網站頂端顯示未確認的必讀公告，按確認後記錄時間（只增不改），後台可看確認名單。頁面 /announcements、區塊 announcements_bar、announcements_list。",
  category: "content",
  priceSetup: 4000,
  priceMonthly: 200,
  requires: ["core"],
  settingsSchema: announcementsSettings,
  sectionTypes: [
    {
      type: "announcements_bar",
      label: "公告橫幅",
      description: "頁面上方一行公告（置頂優先、只顯示上架期間內的）。",
      schema: announcementsBarProps,
      example: { limit: 1 },
    },
    {
      type: "announcements_list",
      label: "公告列表",
      description: "最新公告列表（置頂在前）。",
      schema: announcementsListProps,
      example: { heading: "最新公告", limit: 10 },
    },
  ],
  adminPages: [{ path: "announcements", label: "公告" }],
  mcpTools: ["create_announcement", "update_announcement", "list_announcements", "list_announcement_acks"],
};
