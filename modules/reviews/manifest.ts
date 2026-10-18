import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

/** 評價設定（configure_module，進草稿、發布後生效） */
export const reviewsSettings = z
  .object({
    /** false＝不需審核直接公開（預設 true：店主審核後才公開） */
    requireApproval: z.boolean().optional(),
    /** 允許附圖的網域（https，例如 i.imgur.com）；不設＝不開放附圖 */
    imageHosts: z.array(z.string().trim().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, { message: "網域格式不正確" })).max(10).optional(),
  })
  .strict();
export type ReviewsSettings = z.output<typeof reviewsSettings>;

export const productReviewsProps = z
  .object({
    heading: optText(120),
    /** 商品 slug（比對鍵） */
    productSlug: z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "reviews",
  name: "商品評價",
  description:
    "購買過且訂單已付款（或已出貨）的會員才能評價該商品，每張訂單每個商品一則；星等 1–5、文字、可選白名單網域圖片；預設店主審核後才公開、可回覆；商品頁顯示平均分與評價。內文純文字轉義（防 XSS）。",
  category: "commerce",
  priceSetup: 6000,
  priceMonthly: 300,
  requires: ["shop", "members"],
  settingsSchema: reviewsSettings,
  sectionTypes: [
    {
      type: "product_reviews",
      label: "商品評價",
      description: "某商品的平均星等與已公開評價（商品頁已自動顯示，這個區塊用來放在其他頁面）。",
      schema: productReviewsProps,
      example: { heading: "顧客評價", productSlug: "example-product", limit: 10 },
    },
  ],
  adminPages: [{ path: "reviews", label: "評價" }],
  mcpTools: ["list_reviews", "moderate_review", "reply_review"],
};
