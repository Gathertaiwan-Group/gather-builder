import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText, postSlug } from "@/lib/validators";

/** 預約設定（configure_module，進草稿、發布後生效） */
export const bookingSettings = z
  .object({
    /** 最早可預約：現在起幾分鐘後（預設 120＝2 小時後） */
    minLeadMinutes: z.number().int().min(0).max(10080).optional(),
    /** 最遠可預約：幾天內（預設 60） */
    maxAdvanceDays: z.number().int().min(1).max(365).optional(),
    /** 可選開始時間的間隔（分鐘，預設 30） */
    slotStepMinutes: z.number().int().min(5).max(240).optional(),
    /** 客人自助取消／改期的最晚時間：開始前幾小時（預設 24；0＝開始前都可以） */
    cancelDeadlineHours: z.number().int().min(0).max(720).optional(),
    /** 地點（寫進確認信與 .ics） */
    location: optText(200),
    /** 預約通知信箱（不填用 shop 的 ownerEmail） */
    ownerEmail: z.email({ message: "通知信箱格式不正確" }).optional(),
    /** false = 只有會員能預約 */
    allowGuest: z.boolean().optional(),
    /** false = 不寄前一天的提醒信 */
    reminders: z.boolean().optional(),
    /** 每個 Email（正規化）每天最多幾筆免費／現場付預約（防假資料灌爆，預設 2） */
    freeBookingsPerEmailPerDay: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type BookingSettings = z.output<typeof bookingSettings>;

export const bookingWidgetProps = z
  .object({
    heading: optText(120),
    /** 只顯示某一個服務（不填＝全部已上架服務） */
    serviceSlug: postSlug.optional(),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "booking",
  name: "時段預約",
  description:
    "一對一預約（諮詢、療程、命理、私人教練）：服務（時長、緩衝、價格、線上收訂金／全額／不收）、服務提供者（第一版預設店主一人，資料結構支援多位）、每週可預約時段、例外日（休假／加開）、最早／最遠可約。同一提供者同時段只能一筆（DB 交易鎖）。需付款時走既有訂單＋付款（需 shop），付款前保留、逾期釋放。確認信附 .ics、前一天提醒、客人自助取消／改期（依最晚取消時間）、店主後台週曆。頁面 /book。",
  category: "commerce",
  priceSetup: 12000,
  priceMonthly: 800,
  requires: ["core"],
  settingsSchema: bookingSettings,
  sectionTypes: [
    {
      type: "booking_widget",
      label: "線上預約",
      description: "顯示服務與可預約時段（未來 7 天，可往後翻），點時段填資料完成預約。serviceSlug 可限定單一服務。",
      schema: bookingWidgetProps,
      example: { heading: "線上預約" },
    },
  ],
  adminPages: [{ path: "booking", label: "預約" }],
  mcpTools: ["create_service", "update_service", "list_services", "set_weekly_hours", "add_date_override", "get_booking_availability", "list_bookings", "cancel_booking"],
};
