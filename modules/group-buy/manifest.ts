import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText, postSlug } from "@/lib/validators";

/** 團購設定（configure_module，進草稿、發布後生效） */
export const groupBuySettings = z
  .object({
    /** 團購下單每 IP 每小時上限（爆團時同一個辦公室／行動網路 NAT 可能共用 IP，預設 20） */
    orderRateLimitPerHour: z.number().int().min(1).max(1000).optional(),
    /** 銀行明細配對的時間窗：匯款日期在下單日（台北）之後幾天內才算候選（預設 7） */
    bankMatchWindowDays: z.number().int().min(1).max(60).optional(),
    /** 團購頁顯示的付款說明（例如「匯款後請在訂單頁回報帳號末五碼」） */
    paymentNote: optText(500),
  })
  .strict();
export type GroupBuySettings = z.output<typeof groupBuySettings>;

export const groupBuyListProps = z
  .object({
    heading: optText(120),
    limit: z.number().int().min(1).max(24).default(6),
    /** true＝也列出已結團的團購 */
    showClosed: z.boolean().default(false),
  })
  .strict();

export const groupBuyDetailProps = z
  .object({
    groupBuySlug: postSlug,
    heading: optText(120),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "group-buy",
  name: "團購",
  description:
    "團購活動（團名、團主、開團／截止時間、團購價與每品項限量、成團門檻、宅配／超商／到店自取）。團主（KOL）有專屬連結 /s/<slug>/groupbuy/<團購>?leader=<碼> 與分潤（% 或每單固定金額，只增不改帳、取消沖回），以簽章連結查看自己的報表（買家個資遮罩）。顧客免登入下單，全部走既有結帳（庫存、優惠券、金流、發票、物流）；限量在下單交易內原子扣減。銀行轉帳可匯入銀行明細 CSV 產生「建議配對」，店主確認才標已付款。截止自動結團（未達門檻自動取消並通知），出貨報表／物流匯出（CSV，記錄個資查看），可批次建綠界物流單。",
  category: "commerce",
  priceSetup: 12000,
  priceMonthly: 800,
  requires: ["shop"],
  settingsSchema: groupBuySettings,
  sectionTypes: [
    {
      type: "group_buy_list",
      label: "團購列表",
      description: "列出開團中的團購（封面、團名、截止時間、最低團購價），連到 /groupbuy/<slug>。",
      schema: groupBuyListProps,
      example: { heading: "開團中", limit: 6, showClosed: false },
    },
    {
      type: "group_buy_detail",
      label: "單一團購",
      description: "在任何頁面嵌入一個團購的摘要與「前往下單」按鈕。groupBuySlug 為團購 slug。",
      schema: groupBuyDetailProps,
      example: { groupBuySlug: "autumn-tea" },
    },
  ],
  adminPages: [],
  mcpTools: [
    "create_group_buy",
    "update_group_buy",
    "duplicate_group_buy",
    "list_group_buys",
    "get_group_buy",
    "invite_leader",
    "list_group_buy_orders",
    "import_bank_statement",
    "confirm_bank_matches",
    "close_group_buy",
    "export_shipping",
    "create_group_buy_shipments",
  ],
};
