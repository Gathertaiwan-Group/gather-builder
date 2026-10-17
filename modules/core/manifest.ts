import { z } from "zod";
import type { ModuleManifest } from "../types";
import { imageUrl, optText } from "@/lib/validators";

export const coreSettings = z
  .object({
    ga4MeasurementId: z
      .string()
      .trim()
      .regex(/^G-[A-Z0-9]{4,16}$/, { message: "GA4 評估 ID 格式為 G-XXXXXXX" })
      .optional(),
    siteDescription: optText(300),
    defaultOgImage: imageUrl.optional(),
    footerText: optText(200),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "core",
  name: "核心底座",
  description: "主題、頁面與導覽、SEO（title/description/OG）、sitemap/robots、GA4。所有網站必備。",
  category: "foundation",
  priceSetup: 0,
  priceMonthly: 300,
  requires: [],
  settingsSchema: coreSettings,
  sectionTypes: [],
  mcpTools: ["get_site", "get_page", "upsert_page", "delete_page", "update_nav", "update_theme", "preview_changes", "publish_site", "list_revisions", "rollback"],
  locked: true,
};
