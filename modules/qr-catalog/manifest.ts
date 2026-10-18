import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

/** QR 商品頁設定（configure_module，進草稿、發布後生效） */
export const qrCatalogSettings = z
  .object({
    /** 外幣約當（店主手動設定匯率：1 新台幣 ＝ rate 外幣）；只顯示「僅供參考，以新台幣結帳」 */
    currencies: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Z]{3}$/, { message: "幣別需為 3 碼大寫（JPY、USD…）" }),
            rate: z.number().positive().max(100_000),
          })
          .strict(),
      )
      .max(6)
      .optional(),
    /** 海外寄送詢價通知信箱（不填用 shop 的 ownerEmail） */
    ownerEmail: z.email({ message: "信箱格式不正確" }).optional(),
    /** 落地頁「現場購買」說明（例如「請洽櫃台店員」） */
    inStoreNote: optText(200),
    /** 每 IP 每 10 分鐘記錄的掃描上限（超過仍可看頁面，只是不記錄；預設 60） */
    scanLogLimitPer10Min: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();
export type QrCatalogSettings = z.output<typeof qrCatalogSettings>;

export const manifest: ModuleManifest = {
  id: "qr-catalog",
  name: "實體門市 QR 多語商品頁",
  description:
    "每個商品一組 QR（短連結 /s/<slug>/q/<隨機碼>；可列印 A4 標籤：商品名、價格、QR）。外國客人掃碼依瀏覽器語言自動顯示中／英／日（有翻譯才切、可手動切換），可選顯示外幣約當（店主設定匯率，僅供參考、以新台幣結帳），提供「現場購買請洽店員」「線上購買」「寄送到海外（詢價）」。每次掃描記錄時間、商品、語言、粗略國家（只用 Vercel geo header，不存 IP），後台報表：商品×國家×語言的掃描數與轉成線上訂單／詢價的轉換率。可為每個品牌產生唯讀報表連結（簽章、可撤銷、可設到期，不含顧客個資）。",
  category: "commerce",
  priceSetup: 8000,
  priceMonthly: 500,
  requires: ["shop", "i18n"],
  settingsSchema: qrCatalogSettings,
  sectionTypes: [],
  adminPages: [],
  mcpTools: ["generate_qr_labels", "get_scan_report", "create_brand_report_link", "revoke_brand_report_link", "list_brand_report_links"],
};
