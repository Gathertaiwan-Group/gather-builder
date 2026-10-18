import { z } from "zod";
import type { ModuleManifest } from "../types";

/** 推薦設定（configure_module，進草稿、發布後生效） */
export const referralSettings = z
  .object({
    /** 被推薦人首次付款完成後，發給推薦人的回饋券 */
    rewardCoupon: z
      .object({
        kind: z.enum(["fixed", "percent"]),
        value: z.number().int().min(1).max(100000),
        maxDiscount: z.number().int().min(1).max(100000).optional(),
        minSubtotal: z.number().int().min(0).max(10_000_000).optional(),
        /** 回饋券有效天數（預設 90） */
        validDays: z.number().int().min(1).max(730).optional(),
      })
      .strict()
      .refine((c) => c.kind !== "percent" || (c.value <= 100 && !!c.maxDiscount), { message: "百分比回饋券需為 1–100 且要設 maxDiscount" }),
    /** 每位推薦人每月（台北時間）最多發幾張回饋券，預設 10（防分身帳號刷量） */
    rewardMonthlyLimit: z.number().int().min(1).max(1000).optional(),
    /** KOL 分潤（比例在個別推薦碼上設定，set_referral_kol）；false = 關閉分潤記帳 */
    kolEnabled: z.boolean().optional(),
  })
  .strict();
export type ReferralSettings = z.output<typeof referralSettings>;

export const manifest: ModuleManifest = {
  id: "referral",
  name: "推薦回饋",
  description:
    "每個會員一組推薦碼與分享連結（/s/<slug>/api/ref/<碼>）。被推薦人首次付款完成後，自動發一張回饋券給推薦人（同一被推薦人只觸發一次——email 正規化比對；不能自己推薦自己；每位推薦人每月上限 rewardMonthlyLimit；被推薦訂單取消時回饋券自動停用）。可選 KOL 分潤：對指定推薦碼設比例，每筆付款記一筆分潤帳（只增不改；訂單取消時記一筆沖回）。",
  category: "engagement",
  priceSetup: 5000,
  priceMonthly: 500,
  requires: ["members", "coupons"],
  settingsSchema: referralSettings,
  sectionTypes: [],
  adminPages: [{ path: "marketing", label: "行銷" }],
  mcpTools: ["list_referrals", "set_referral_kol"],
};
