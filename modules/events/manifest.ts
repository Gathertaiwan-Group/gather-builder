import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText, postSlug } from "@/lib/validators";

/** 活動設定（configure_module，進草稿、發布後生效） */
export const eventsSettings = z
  .object({
    /** 候補遞補時給候補者的保留時數（1–72，預設 24；不超過開場時間） */
    waitlistOfferHours: z.number().int().min(1).max(72).optional(),
    /** false = 不寄活動前提醒信（預設寄：每日 cron 寄「今天稍晚與明天」的場次，每筆只寄一次） */
    reminders: z.boolean().optional(),
    /** 報名通知信箱（不填用 shop 的 ownerEmail） */
    ownerEmail: z.email({ message: "通知信箱格式不正確" }).optional(),
    /** false = 只有會員能報名（預設可訪客報名） */
    allowGuest: z.boolean().optional(),
    /** 免費報名與候補需要先點 email 確認連結（預設 true；確認前名額只保留 30 分鐘）。已登入且 email 已驗證的會員免確認 */
    requireEmailConfirm: z.boolean().optional(),
  })
  .strict();
export type EventsSettings = z.output<typeof eventsSettings>;

export const eventsListProps = z
  .object({
    heading: optText(120),
    limit: z.number().int().min(1).max(30).default(6),
    showAllLink: z.boolean().default(true),
  })
  .strict();

export const eventDetailProps = z
  .object({
    eventSlug: postSlug,
    heading: optText(120),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "events",
  name: "活動報名",
  description:
    "工作坊／講座／課程梯次：活動 → 場次（時間、容量）→ 票種（價格 0＝免費、每單上限、販售期間、配額）。免費票直接成立；付費票走既有訂單＋付款（線下匯款或 PChomePay，需啟用 shop），付款前先保留名額、逾期自動釋放。額滿可登記候補，有人取消／逾期時依序通知並保留 24 小時。後台名單（個資遮罩、查看留紀錄）、CSV 匯出、簽到、活動前提醒、取消場次通知。頁面固定在 /events、/events/<活動>。",
  category: "commerce",
  priceSetup: 12000,
  priceMonthly: 800,
  requires: ["core"],
  settingsSchema: eventsSettings,
  sectionTypes: [
    {
      type: "events_list",
      label: "活動列表",
      description: "列出已上架、還有未來場次的活動（標題、時間、地點、最低票價、是否額滿），連到 /events/<slug>。",
      schema: eventsListProps,
      example: { heading: "近期活動", limit: 6, showAllLink: true },
    },
    {
      type: "event_detail",
      label: "單一活動",
      description: "在任何頁面嵌入一個活動的場次與報名入口。eventSlug 為活動 slug。",
      schema: eventDetailProps,
      example: { eventSlug: "example-workshop" },
    },
  ],
  adminPages: [{ path: "events", label: "活動" }],
  mcpTools: ["create_event", "update_event", "create_session", "create_ticket_type", "list_events", "list_registrations", "check_in", "cancel_session"],
};
