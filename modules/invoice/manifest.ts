import { z } from "zod";
import type { ModuleManifest } from "../types";
import { LOVE_CODE } from "@/lib/invoice/validate";

/** 發票設定（configure_module，進草稿、發布後生效）。憑證不在這裡：只能從平台後台「電子發票」分頁輸入。 */
export const invoiceSettings = z
  .object({
    /** 開立時機：manual（預設，後台或 MCP issue_invoice）／auto_on_paid（付款成功自動開立） */
    issueMode: z.enum(["manual", "auto_on_paid"]).optional(),
    /** 結帳頁提供的發票選項（會員載具一律提供） */
    allowMobileBarcode: z.boolean().optional(),
    allowCertificate: z.boolean().optional(),
    allowDonation: z.boolean().optional(),
    allowB2B: z.boolean().optional(),
    /** 捐贈時預設愛心碼（3–7 碼數字） */
    defaultLoveCode: z.string().regex(LOVE_CODE, { message: "愛心碼需為 3–7 碼數字" }).optional(),
  })
  .strict();
export type InvoiceSettings = z.output<typeof invoiceSettings>;

export const manifest: ModuleManifest = {
  id: "invoice",
  name: "電子發票",
  description:
    "訂單電子發票（第一家供應商：Amego 光貿）。結帳頁提供會員載具、手機條碼、自然人憑證、捐贈、三聯式（統編檢查碼驗證）。開立時機預設「手動」（後台或 issue_invoice confirm:true），可設為「付款成功自動開立」（同一訂單只會開一張，DB 唯一約束保證）。作廢：同期作廢、跨期改開折讓。🔴 Amego 憑證只能由平台擁有者在後台輸入；Amego 要求白名單 IP，正式使用前必須設固定 IP 中繼。",
  category: "commerce",
  priceSetup: 8000,
  priceMonthly: 500,
  requires: ["shop"],
  settingsSchema: invoiceSettings,
  sectionTypes: [],
  adminPages: [{ path: "invoices", label: "電子發票" }],
  mcpTools: ["get_invoice_setup_status", "list_invoices", "get_invoice", "issue_invoice", "retry_invoice", "void_invoice"],
};
