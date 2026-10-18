import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const newsletterSettings = z
  .object({
    /** 每封信最後附的寄件人說明（例如店名、地址），不可放 HTML */
    footer: optText(300),
    /** 每 IP 每小時訂閱上限（預設 5） */
    rateLimitPerHour: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const newsletterSignupProps = z
  .object({
    heading: optText(120),
    description: optText(300),
    buttonLabel: optText(20),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "newsletter",
  name: "電子報",
  description:
    "電子報訂閱區塊（newsletter_signup）＋雙重確認（確認信連結）、訂閱者列表、群發（草稿 → 寄測試信 → confirm 群發；只寄給已確認且未退訂者、分批、記錄每封結果、同一份不能重複群發）。每封信附一次性退訂連結。",
  category: "engagement",
  priceSetup: 3000,
  priceMonthly: 300,
  requires: ["core"],
  settingsSchema: newsletterSettings,
  sectionTypes: [
    {
      type: "newsletter_signup",
      label: "電子報訂閱",
      description: "Email 訂閱表單（會寄確認信，確認後才算訂閱）。",
      schema: newsletterSignupProps,
      example: { heading: "訂閱電子報", description: "新品與活動第一手消息", buttonLabel: "訂閱" },
    },
  ],
  adminPages: [{ path: "newsletter", label: "電子報" }],
  mcpTools: ["list_subscribers", "create_broadcast", "send_test_broadcast", "send_broadcast", "list_broadcasts"],
};
