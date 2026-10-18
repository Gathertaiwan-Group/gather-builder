import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

/** 訂閱設定（configure_module，進草稿、發布後生效） */
export const subscriptionsSettings = z
  .object({
    /** 扣款失敗後的寬限天數（期間仍保有權益；到期仍未成功就停權），預設 7 */
    graceDays: z.number().int().min(0).max(30).optional(),
    /** 店主通知信箱（不填用 shop 的 ownerEmail） */
    ownerEmail: z.email({ message: "通知信箱格式不正確" }).optional(),
    /** 顯示在方案旁的注意事項（例如取消規則） */
    notice: optText(1000),
  })
  .strict();
export type SubscriptionsSettings = z.output<typeof subscriptionsSettings>;

export const subscriptionPlansProps = z
  .object({
    heading: optText(120),
    intro: optText(400),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "subscriptions",
  name: "訂閱制（定期扣款）",
  description:
    "會員訂閱方案（名稱、金額、每月／每年、試用天數、權益：開通課程或純月費）。第一個 provider：藍新信用卡定期定額（每個網站用自己的藍新商店，需開通定期定額）。每期扣款以通知＋權威回查確認（委託單查詢＋交易查詢），同一期只入帳一次；扣款失敗進寬限期並通知，寬限到期停權收回權益；會員可在會員中心取消（終止委託，失敗會自動重試並記錄）。區塊 subscription_plans。",
  category: "commerce",
  priceSetup: 15000,
  priceMonthly: 900,
  requires: ["members", "shop"],
  settingsSchema: subscriptionsSettings,
  sectionTypes: [
    {
      type: "subscription_plans",
      label: "訂閱方案",
      description: "列出上架中的訂閱方案（金額、週期、試用期），會員登入後可訂閱（轉到藍新信用卡定期定額頁）。",
      schema: subscriptionPlansProps,
      example: { heading: "會員方案" },
    },
  ],
  adminPages: [{ path: "subscriptions", label: "訂閱" }],
  mcpTools: ["create_subscription_plan", "update_subscription_plan", "list_subscription_plans", "list_subscriptions", "cancel_subscription"],
};
