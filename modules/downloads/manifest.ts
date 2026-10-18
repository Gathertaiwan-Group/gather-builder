import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const downloadsSettings = z.object({ listTitle: optText(60) }).strict();

export const downloadsListProps = z
  .object({
    heading: optText(120),
    /** 只列某一分類 */
    category: optText(40),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "downloads",
  name: "文件下載",
  description:
    "文件（標題、分類、說明、檔案、公開或限會員）。檔案放私有 Storage，下載一律走 60 秒簽名網址；限會員的文件由伺服器檢查會員登入。檔名淨化與副檔名白名單、單檔 50MB（大檔走簽名上傳網址直傳）、下載次數統計。頁面 /downloads、區塊 downloads_list。",
  category: "content",
  priceSetup: 6000,
  priceMonthly: 300,
  requires: ["core"],
  settingsSchema: downloadsSettings,
  sectionTypes: [
    {
      type: "downloads_list",
      label: "文件下載",
      description: "列出已上架的文件（限會員的文件顯示「登入後下載」）。category 只列某一分類。",
      schema: downloadsListProps,
      example: { heading: "表單下載", limit: 20 },
    },
  ],
  adminPages: [{ path: "downloads", label: "文件" }],
  mcpTools: ["create_document_upload", "complete_document_upload", "update_document", "list_documents"],
};
