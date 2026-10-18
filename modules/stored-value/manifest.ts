import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

/** 儲值設定（configure_module，進草稿、發布後生效） */
export const storedValueSettings = z
  .object({
    /** 購買儲值通知信箱（不填用 shop 的 ownerEmail） */
    ownerEmail: z.email({ message: "通知信箱格式不正確" }).optional(),
    /** 顯示在儲值頁的注意事項（例如履約保證說明、退款規則） */
    notice: optText(1000),
    /** 店主手動調整儲值金（adjust_balance）單次上限（NT$，預設 3,000）——審查 M3 */
    adjustMaxPerCall: z.number().int().min(1).max(1_000_000).optional(),
    /** 店主手動調整每日上限（全站加總、台北日，預設 NT$10,000） */
    adjustMaxPerDay: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict();
export type StoredValueSettings = z.output<typeof storedValueSettings>;

export const topupPlansProps = z
  .object({
    heading: optText(120),
    intro: optText(400),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "stored-value",
  name: "儲值金",
  description:
    "儲值方案（付 X 得 Y，可含另設到期日的贈送額度），購買走既有訂單＋付款，付款真正成功那次才入帳（sandbox 不入帳）；結帳可用儲值金全額或部分支付（下單交易內原子扣款、取消冪等退回）。會員中心顯示餘額與明細，儲值帳本只增不改。🔴 儲值金屬預收款：正式上線前店家應自行確認是否需依《零售業等禮券定型化契約》等規定提供履約保證或信託，平台只提供功能。頁面 /wallet。",
  category: "commerce",
  priceSetup: 12000,
  priceMonthly: 800,
  requires: ["members", "shop"],
  settingsSchema: storedValueSettings,
  sectionTypes: [
    {
      type: "topup_plans",
      label: "儲值方案",
      description: "列出已上架的儲值方案（付多少、得多少、贈送額度到期），會員可直接購買。",
      schema: topupPlansProps,
      example: { heading: "儲值方案" },
    },
  ],
  adminPages: [{ path: "loyalty", label: "會員經營" }],
  mcpTools: ["get_member_balance", "adjust_balance", "create_topup_plan", "update_topup_plan", "list_topup_plans"],
};
