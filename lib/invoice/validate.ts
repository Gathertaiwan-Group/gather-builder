import { z } from "zod";
import type { InvoiceRequest } from "../store/types";

/**
 * 營利事業統一編號檢查碼（財政部 2023 起的規則：加權和可被 5 整除；
 * 第 7 碼為 7 時，加權和或加權和 +1 可被 5 整除即可）。
 * 權數 1,2,1,2,1,2,4,1；乘積若為兩位數則十位與個位相加。
 */
export function isValidTaxId(id: string): boolean {
  if (!/^[0-9]{8}$/.test(id) || id === "00000000") return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const p = Number(id[i]) * w[i]!;
    sum += Math.floor(p / 10) + (p % 10);
  }
  if (sum % 5 === 0) return true;
  return id[6] === "7" && (sum + 1) % 5 === 0;
}

/** 手機條碼載具：/ 開頭＋7 碼（0-9 A-Z . + -），大寫 */
export const MOBILE_BARCODE = /^\/[0-9A-Z.+-]{7}$/;
/** 自然人憑證條碼：2 碼大寫英文＋14 碼數字 */
export const CERTIFICATE = /^[A-Z]{2}[0-9]{14}$/;
/** 捐贈碼（愛心碼）：3–7 碼數字 */
export const LOVE_CODE = /^[0-9]{3,7}$/;

export const invoiceRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("member") }).strict(),
  z.object({ type: z.literal("mobile"), carrier: z.string().trim().toUpperCase().regex(MOBILE_BARCODE, { message: "手機條碼格式不正確（/ 開頭共 8 碼）" }) }).strict(),
  z.object({ type: z.literal("certificate"), carrier: z.string().trim().toUpperCase().regex(CERTIFICATE, { message: "自然人憑證條碼格式不正確（2 碼英文＋14 碼數字）" }) }).strict(),
  z.object({ type: z.literal("donation"), loveCode: z.string().trim().regex(LOVE_CODE, { message: "捐贈碼需為 3–7 碼數字" }) }).strict(),
  z
    .object({
      type: z.literal("b2b"),
      taxId: z.string().trim().refine(isValidTaxId, { message: "統一編號不正確（8 碼數字且檢查碼要正確）" }),
      title: z.string().trim().min(1, { message: "請填寫公司抬頭" }).max(60),
    })
    .strict(),
]);

/** 結帳表單 → 發票需求（欄位名：invoiceType、invoiceCarrier、invoiceLoveCode、invoiceTaxId、invoiceTitle） */
export function invoiceRequestFromForm(f: Record<string, string>): unknown {
  const type = f.invoiceType || "member";
  switch (type) {
    case "mobile":
    case "certificate":
      return { type, carrier: f.invoiceCarrier ?? "" };
    case "donation":
      return { type, loveCode: f.invoiceLoveCode ?? "" };
    case "b2b":
      return { type, taxId: f.invoiceTaxId ?? "", title: f.invoiceTitle ?? "" };
    default:
      return { type: "member" };
  }
}

export function describeInvoiceRequest(r: InvoiceRequest | null | undefined): string {
  if (!r) return "（未指定，使用會員載具）";
  switch (r.type) {
    case "member":
      return "會員載具（寄到 Email）";
    case "mobile":
      return `手機條碼 ${r.carrier}`;
    case "certificate":
      return `自然人憑證 ${r.carrier}`;
    case "donation":
      return `捐贈（愛心碼 ${r.loveCode}）`;
    case "b2b":
      return `三聯式 ${r.taxId} ${r.title}`;
  }
}
