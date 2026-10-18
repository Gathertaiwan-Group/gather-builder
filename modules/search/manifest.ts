import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const searchSettings = z
  .object({
    /** 搜尋框提示文字 */
    placeholder: optText(60),
  })
  .strict();

export const searchBoxProps = z
  .object({
    heading: optText(120),
    placeholder: optText(60),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "search",
  name: "站內搜尋",
  description:
    "搜尋已發布的頁面文字、文章、商品、活動、課程（介紹與單元標題）、人員名錄、公開文件；只搜這個網站、只搜已發布、付費課程內文不會被搜出；中文片語可搜；外文網址也搜已發布的翻譯。頁面 /search?q=、區塊 search_box、每 IP 限流。",
  category: "content",
  priceSetup: 5000,
  priceMonthly: 300,
  requires: ["core"],
  settingsSchema: searchSettings,
  sectionTypes: [
    {
      type: "search_box",
      label: "搜尋框",
      description: "站內搜尋輸入框，送出後到 /search 顯示結果。",
      schema: searchBoxProps,
      example: { heading: "找找看", placeholder: "輸入關鍵字" },
    },
  ],
  mcpTools: [],
};
