import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const contactSettings = z
  .object({
    notifyEmail: z.email({ message: "通知信箱格式不正確" }).optional(),
    rateLimitPerHour: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const contactFormProps = z
  .object({
    heading: optText(120),
    intro: optText(400),
    submitLabel: optText(30),
    successMessage: optText(200),
    showPhone: z.boolean().default(true),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "contact-form",
  name: "聯絡表單",
  description: "訪客留言表單，送出存入詢問收件匣；防機器人（honeypot）與每 IP 限流；設定通知信箱即寄通知信。",
  category: "engagement",
  priceSetup: 3000,
  priceMonthly: 100,
  requires: ["core"],
  settingsSchema: contactSettings,
  sectionTypes: [
    { type: "contact_form", label: "聯絡表單", description: "姓名、Email、電話（可關）、留言的表單。區塊錨點固定為 #contact。", schema: contactFormProps, example: { heading: "聯絡我們", intro: "留下訊息，我們會盡快回覆。" } },
  ],
  adminPages: [{ path: "inquiries", label: "詢問" }],
  mcpTools: ["list_inquiries"],
};
