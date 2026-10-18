import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText, postSlug } from "@/lib/validators";

/** 商店設定（configure_module 寫進草稿，發布後才生效） */
export const shopSettings = z
  .object({
    /** 固定運費（新台幣，整數） */
    shippingFee: z.number().int().min(0).max(100000).optional(),
    /** 滿額免運門檻（小計 ≥ 門檻則運費 0） */
    freeShippingThreshold: z.number().int().min(0).max(10000000).optional(),
    /** 店主通知信箱（下單、付款成功、異常警示） */
    ownerEmail: z.email({ message: "店主信箱格式不正確" }).optional(),
    /** 訂單編號前綴，2–8 碼大寫英數，例如 LIN → LIN-20261018-0001 */
    orderPrefix: z
      .string()
      .regex(/^[A-Z0-9]{2,8}$/, { message: "訂單前綴需為 2–8 碼大寫英數" })
      .optional(),
    /** 未付款訂單保留時數（逾期自動取消並回補庫存），預設 72 */
    orderExpireHours: z.number().int().min(1).max(168).optional(),
    /** false = 只允許會員結帳 */
    allowGuestCheckout: z.boolean().optional(),
    /** 線下匯款：enabled＋給客人的匯款說明（帳號等） */
    offlineTransfer: z.object({ enabled: z.boolean(), instructions: optText(1000) }).strict().optional(),
    /** false = 即使憑證已驗證也不提供 PChomePay */
    pchomepay: z.boolean().optional(),
    /** 第七批：不提供的線上金流（憑證已驗證也不顯示），例如 ["linepay"] */
    disabledProviders: z.array(z.enum(["pchomepay", "newebpay", "ecpay", "linepay", "blackcat", "payuni"])).max(6).optional(),
    /** 線上刷卡訂單的保留時間（分鐘），逾期未付自動取消並回補庫存；預設 60 */
    onlinePaymentHoldMinutes: z.number().int().min(15).max(1440).optional(),
    /** true = 另外提供「ATM 轉帳」（保留 orderExpireHours，需 ≥ 48 小時；ATM 繳費期限一定短於保留時間） */
    pchomepayAtm: z.boolean().optional(),
    /** 每張訂單每個品項的數量上限（1–99），預設 10 */
    maxQtyPerItem: z.number().int().min(1).max(99).optional(),
  })
  .strict();
export type ShopSettings = z.output<typeof shopSettings>;

export const productGridProps = z
  .object({
    heading: optText(120),
    limit: z.number().int().min(1).max(48).default(12),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
    showAllLink: z.boolean().default(true),
  })
  .strict();

export const productDetailProps = z
  .object({
    productSlug: postSlug,
    heading: optText(120),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "shop",
  name: "電商核心",
  description:
    "商品（含規格與庫存）、購物車、結帳（訪客或會員）、訂單管理、線上付款（PChomePay、藍新、綠界、LINE Pay、黑貓 PAY、PAYUNi，每個網站用自己的商家帳號、可同時設定多家，結帳只顯示已驗證的）與線下匯款。頁面固定在 /shop、/shop/<商品>、/checkout、/orders/<訂單編號>。需先在平台後台「金流設定」輸入並驗證至少一家的憑證，否則為 pending_setup（仍可只開線下匯款）。",
  category: "commerce",
  priceSetup: 30000,
  priceMonthly: 1500,
  requires: ["core", "members"],
  settingsSchema: shopSettings,
  sectionTypes: [
    {
      type: "product_grid",
      label: "商品列表",
      description: "列出已上架商品（圖、名稱、價格），連到商品頁 /shop/<slug>。",
      schema: productGridProps,
      example: { heading: "精選商品", limit: 6, columns: 3, showAllLink: true },
    },
    {
      type: "product_detail",
      label: "單一商品",
      description: "在任何頁面嵌入一個商品（圖、說明、規格、加入購物車）。productSlug 為商品 slug。",
      schema: productDetailProps,
      example: { productSlug: "example-product" },
    },
  ],
  adminPages: [
    { path: "products", label: "商品" },
    { path: "orders", label: "訂單" },
    { path: "payments", label: "金流設定" },
  ],
  mcpTools: [
    "create_product",
    "update_product",
    "list_products",
    "list_orders",
    "get_order",
    "mark_order_paid",
    "fulfill_order",
    "cancel_order",
    "get_payment_setup_status",
  ],
};
