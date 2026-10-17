import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const portfolioGridProps = z
  .object({
    heading: optText(120),
    tag: optText(40),
    columns: z.union([z.literal(2), z.literal(3)]).default(3),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "portfolio",
  name: "作品集",
  description: "作品項目管理＋作品網格區塊（點擊開燈箱看大圖與說明），可依標籤篩選。",
  category: "content",
  priceSetup: 5000,
  priceMonthly: 200,
  requires: ["core", "sections-basic"],
  settingsSchema: z.object({}).strict(),
  sectionTypes: [
    { type: "portfolio_grid", label: "作品網格", description: "以網格顯示作品集項目，點擊放大。可用 tag 只顯示某類作品。", schema: portfolioGridProps, example: { heading: "作品集", columns: 3 } },
  ],
  adminPages: [{ path: "portfolio", label: "作品" }],
  mcpTools: ["create_portfolio_item", "update_portfolio_item"],
};
