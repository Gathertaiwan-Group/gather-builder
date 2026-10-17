import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const blogSettings = z
  .object({
    listTitle: optText(60),
    postsPerPage: z.number().int().min(3).max(30).optional(),
  })
  .strict();

export const postsListProps = z
  .object({
    heading: optText(120),
    limit: z.number().int().min(1).max(12).default(3),
    showExcerpt: z.boolean().default(true),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "blog",
  name: "部落格/最新消息",
  description: "文章列表頁 /blog、文章內頁 /blog/<slug>，以及可放在任何頁面的「最新文章」區塊。",
  category: "content",
  priceSetup: 5000,
  priceMonthly: 200,
  requires: ["core"],
  settingsSchema: blogSettings,
  sectionTypes: [
    { type: "posts_list", label: "最新文章", description: "列出最近發布的 N 篇文章（標題、日期、摘要），連到文章頁。", schema: postsListProps, example: { heading: "最新消息", limit: 3, showExcerpt: true } },
  ],
  adminPages: [{ path: "posts", label: "文章" }],
  mcpTools: ["create_post", "update_post", "list_posts"],
};
