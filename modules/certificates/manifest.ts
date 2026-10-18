import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText } from "@/lib/validators";

export const certificatesSettings = z
  .object({
    /** 查詢頁標題（預設「證照查詢」） */
    title: optText(60),
    /** 查詢頁說明 */
    intro: optText(500),
    /**
     * 審查 M5：允許「只用證號」查詢（預設 false＝證號模式也必須填姓名，兩者都對才查得到）。
     * 打開後任何拿到證號的人都能看到持有人遮罩姓名與狀態，請店主自行評估。
     */
    allowCertNoOnly: z.boolean().optional(),
  })
  .strict();

export const certificateLookupProps = z.object({ heading: optText(120), intro: optText(400) }).strict();

export const manifest: ModuleManifest = {
  id: "certificates",
  name: "證照查詢",
  description:
    "證照資料（證號、姓名、生日、類別、發證日、到期日、狀態），後台 CSV 匯入（驗證格式、拒絕公式開頭防 CSV injection）。公開查詢頁 /verify：姓名＋生日，或證號＋姓名（只用證號查詢預設關閉，設定 allowCertNoOnly 才開）；不回傳生日、姓名遮罩、查無與不符同一句話、證號容錯（全形、大小寫、空白、分隔符號）、每 IP 與每個查詢鍵嚴格限流、查詢紀錄。區塊 certificate_lookup。",
  category: "content",
  priceSetup: 8000,
  priceMonthly: 500,
  requires: ["core"],
  settingsSchema: certificatesSettings,
  sectionTypes: [
    {
      type: "certificate_lookup",
      label: "證照查詢",
      description: "嵌入證照查詢表單（姓名＋生日或證號）。",
      schema: certificateLookupProps,
      example: { heading: "證照查詢" },
    },
  ],
  adminPages: [{ path: "certificates", label: "證照" }],
  mcpTools: ["import_certificates", "list_certificates", "set_certificate_status", "list_certificate_lookups"],
};
