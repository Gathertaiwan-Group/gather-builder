import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as events from "../services/events";
import * as booking from "../services/booking";
import * as courses from "../services/courses";

/**
 * 第四批 MCP 工具（events／booking／courses）：只做參數宣告與轉送，邏輯全在 lib/services。
 * 由 lib/mcp/tools.ts 的 registerTools 呼叫。
 */

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const site = z.string().optional().describe("網站 slug（租戶 token 可省略；平台 token 必填）");
const confirm = z.boolean().optional().describe("使用者確認後才設 true");
const iso = (what: string) => z.string().describe(`${what}（ISO 8601 並帶時區，例如 2026-11-01T14:00:00+08:00）`);

export function registerClassTools(server: McpServer, ctx: ServiceContext, wrap: Wrap) {
  /* ------------------------------------------------------------ 活動報名（events） */

  const eventFields = {
    slug: z.string().describe("活動網址代稱（小寫英數與連字號），頁面在 /events/<slug>"),
    title: z.string(),
    summary: z.string().optional().describe("一句話簡介（列表卡片顯示）"),
    bodyMd: z.string().optional().describe("活動內容 Markdown"),
    coverUrl: z.string().optional().describe("封面圖 https:// 網址"),
    locationType: z.enum(["physical", "online", "hybrid"]).optional(),
    location: z.string().optional().describe("地點（實體活動）"),
    onlineUrl: z.string().optional().describe("線上活動連結：只寄給已確認的報名者，不公開"),
    status: z.enum(["draft", "published"]).optional().describe("預設 draft；published 需要 publish scope＋confirm"),
    sort: z.number().int().optional(),
  };

  server.registerTool(
    "create_event",
    {
      description:
        "建立活動（工作坊、講座、課程梯次）。預設草稿；接著 create_session 加場次、create_ticket_type 加票種，最後 update_event { patch: { status: \"published\" }, confirm: true } 上架。直接以 published 建立需要 publish scope＋confirm。需要 classes:write。",
      inputSchema: { site, confirm, ...eventFields },
      annotations: WRITE,
    },
    wrap(async (a) => events.createEvent(ctx, a)),
  );

  server.registerTool(
    "update_event",
    {
      description: "修改活動（標題、內容、封面、地點、線上連結、上架／下架）。修改已上架的活動或上架／下架都會立即對外，需要 publish scope＋confirm。取消某一場請用 cancel_session。需要 classes:write。",
      inputSchema: { site, eventId: z.string().optional(), slug: z.string().optional().describe("活動 slug（或給 eventId）"), confirm, patch: z.object(eventFields).partial() },
      annotations: WRITE,
    },
    wrap(async (a) => events.updateEvent(ctx, a)),
  );

  server.registerTool(
    "create_session",
    {
      description: "為活動新增場次（開始／結束時間、容量；時區 Asia/Taipei）。offlineSeats＝店主手動保留或線下已售的座位（計入名額）。活動已上架時需要 publish scope＋confirm。需要 classes:write。",
      inputSchema: {
        site,
        confirm,
        eventId: z.string().optional(),
        eventSlug: z.string().optional(),
        startsAt: iso("開始時間"),
        endsAt: iso("結束時間"),
        capacity: z.number().int().describe("容量（人數）"),
        offlineSeats: z.number().int().optional(),
      },
      annotations: WRITE,
    },
    wrap(async (a) => events.createSession(ctx, a)),
  );

  server.registerTool(
    "create_ticket_type",
    {
      description:
        "為場次新增票種：price 0＝免費（直接成立）；付費票走訂單＋付款（需啟用 shop、線下匯款或 PChomePay），付款前保留名額、逾期自動釋放。maxPerOrder 每筆上限、salesStart/salesEnd 販售期間、quota 票種配額（可選）。活動已上架時需要 publish scope＋confirm。需要 classes:write。",
      inputSchema: {
        site,
        confirm,
        sessionId: z.string(),
        name: z.string().describe("票種名稱，例如「早鳥票」"),
        price: z.number().int().describe("NT$ 整數，0＝免費"),
        maxPerOrder: z.number().int().optional(),
        salesStart: z.string().optional(),
        salesEnd: z.string().optional(),
        quota: z.number().int().optional(),
        sort: z.number().int().optional(),
      },
      annotations: WRITE,
    },
    wrap(async (a) => events.createTicketType(ctx, a)),
  );

  server.registerTool(
    "list_events",
    {
      description: "列出活動與場次、票種、即時名額（已報名、候補保留、候補人數、剩餘）。需要 site:read。",
      inputSchema: { site, status: z.enum(["draft", "published", "cancelled"]).optional(), limit: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => events.listEvents(ctx, a)),
  );

  server.registerTool(
    "list_registrations",
    {
      description: "活動名單（某場次 sessionId，或整個活動 eventId／eventSlug）：票種、張數、狀態（held 待付款／confirmed／cancelled／expired）、簽到時間、是否待退款。🔴 聯絡資料一律遮罩；完整資料與 CSV 匯出只在平台後台（會留查看紀錄）。需要 attendees:read。",
      inputSchema: { site, sessionId: z.string().optional(), eventId: z.string().optional(), eventSlug: z.string().optional(), status: z.array(z.enum(["held", "confirmed", "cancelled", "expired"])).optional() },
      annotations: RO,
    },
    wrap(async (a) => events.listRegistrations(ctx, a)),
  );

  server.registerTool(
    "check_in",
    {
      description: "簽到：給 registrationId 或報名者的簽到碼（確認信裡的 10 碼）。只有已確認（免費或已付款）的報名能簽到，同一筆只會簽到一次。必須 confirm: true。需要 attendees:write。",
      inputSchema: { site, registrationId: z.string().optional(), code: z.string().optional(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => events.checkIn(ctx, a)),
  );

  server.registerTool(
    "cancel_session",
    {
      description:
        "取消一個場次（無法復原）：通知所有報名者與候補者；未付款的保留直接取消；已付款的報名標記「待退款」（🔴 不會自動退款，請人工退款）。必須先讓使用者確認，再帶 confirm: true。需要 classes:write。",
      inputSchema: { site, sessionId: z.string(), reason: z.string().optional(), confirm },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => events.cancelSession(ctx, a)),
  );

  /* ------------------------------------------------------------ 時段預約（booking） */

  const serviceFields = {
    slug: z.string().describe("服務代稱（小寫英數與連字號）"),
    name: z.string(),
    descriptionMd: z.string().optional(),
    durationMin: z.number().int().describe("時長（分鐘）"),
    bufferMin: z.number().int().optional().describe("每筆之後的緩衝（分鐘），期間不能被預約"),
    price: z.number().int().optional().describe("價格 NT$"),
    paymentMode: z.enum(["none", "deposit", "full"]).optional().describe("none 現場付（預設）；deposit 線上收訂金；full 線上收全額（後兩者需要 shop）"),
    depositAmount: z.number().int().optional(),
    status: z.enum(["draft", "published"]).optional().describe("published 需要 publish scope＋confirm"),
    sort: z.number().int().optional(),
  };

  server.registerTool(
    "create_service",
    {
      description: "建立預約服務（時長、緩衝、價格、付款方式）。第一版服務提供者預設為店主一人（自動建立）。直接上架需要 publish＋confirm。之後用 set_weekly_hours 設定可預約時段。需要 classes:write。",
      inputSchema: { site, confirm, ...serviceFields },
      annotations: WRITE,
    },
    wrap(async (a) => booking.createService(ctx, a)),
  );

  server.registerTool(
    "update_service",
    {
      description: "修改預約服務（名稱、時長、緩衝、價格、付款方式、上架／下架）。改已上架服務或上架／下架會立即對外，需要 publish＋confirm。已成立的預約不受影響。需要 classes:write。",
      inputSchema: { site, serviceId: z.string().optional(), slug: z.string().optional(), confirm, patch: z.object(serviceFields).partial() },
      annotations: WRITE,
    },
    wrap(async (a) => booking.updateService(ctx, a)),
  );

  server.registerTool(
    "list_services",
    {
      description: "列出預約服務、服務提供者、每週時段與預約設定（最早／最遠可約、時段間隔、最晚取消時間）。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => booking.listServices(ctx, a)),
  );

  server.registerTool(
    "set_weekly_hours",
    {
      description: "整份取代每週可預約時段（台北時間；weekday 0＝週日…6＝週六；start/end 為 HH:MM，可一天多段）。會立即改變線上可預約時段：需要 publish scope＋confirm。已成立的預約不受影響。需要 classes:write。",
      inputSchema: { site, providerId: z.string().optional(), confirm, hours: z.array(z.object({ weekday: z.number().int(), start: z.string(), end: z.string() })) },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => booking.setWeeklyHours(ctx, a)),
  );

  server.registerTool(
    "add_date_override",
    {
      description: "例外日：kind closed＝整天休假（蓋掉每週時段）；kind open＝加開時段（帶 start/end HH:MM）。日期為台北日期 YYYY-MM-DD。立即生效：需要 publish＋confirm。休假不會自動取消已有的預約（回傳會提示）。需要 classes:write。",
      inputSchema: { site, providerId: z.string().optional(), confirm, date: z.string(), kind: z.enum(["closed", "open"]), start: z.string().optional(), end: z.string().optional(), note: z.string().optional() },
      annotations: WRITE,
    },
    wrap(async (a) => booking.addDateOverride(ctx, a)),
  );

  server.registerTool(
    "get_booking_availability",
    {
      description: "查某服務接下來幾天的可預約時段（已扣掉已預約、緩衝、例外日、最早／最遠可約）。需要 site:read。",
      inputSchema: { site, serviceId: z.string().optional(), serviceSlug: z.string().optional(), fromDate: z.string().optional().describe("YYYY-MM-DD（台北），預設今天"), days: z.number().int().optional().describe("1–31，預設 7") },
      annotations: RO,
    },
    wrap(async (a) => booking.getBookingAvailability(ctx, a)),
  );

  server.registerTool(
    "list_bookings",
    {
      description: "預約列表（預設昨天起 60 天；from/to 為 ISO 時間）：服務、時間、狀態（held 待付款／confirmed／cancelled／expired）、金額、是否待退款。🔴 聯絡資料遮罩。需要 attendees:read。",
      inputSchema: { site, from: z.string().optional(), to: z.string().optional(), status: z.array(z.enum(["held", "confirmed", "cancelled", "expired"])).optional() },
      annotations: RO,
    },
    wrap(async (a) => booking.listBookings(ctx, a)),
  );

  server.registerTool(
    "cancel_booking",
    {
      description: "店家取消一筆預約並通知客人（附取消用 .ics）。未付款保留 → 取消訂單；已付款 → 標待退款（🔴 不會自動退款）。必須先讓使用者確認，再帶 confirm: true。需要 attendees:write。",
      inputSchema: { site, bookingId: z.string(), reason: z.string().optional(), confirm },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => booking.cancelBooking(ctx, a)),
  );

  /* ------------------------------------------------------------ 線上課程（courses） */

  const courseFields = {
    slug: z.string().describe("課程代稱（小寫英數與連字號），頁面在 /courses/<slug>"),
    title: z.string(),
    summary: z.string().optional(),
    bodyMd: z.string().optional().describe("課程介紹 Markdown"),
    coverUrl: z.string().optional(),
    price: z.number().int().optional().describe("NT$；0＝免費（登入會員可直接加入）；付費需要 shop"),
    status: z.enum(["draft", "published"]).optional().describe("published 需要 publish scope＋confirm"),
    sort: z.number().int().optional(),
  };
  const lessonFields = {
    slug: z.string(),
    title: z.string(),
    videoUrl: z.string().optional().describe("YouTube（含未公開連結）或 Vimeo 的 https 網址；其他網域會被拒"),
    bodyMd: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), url: z.string() })).optional().describe("附件下載（https）"),
    isPreview: z.boolean().optional().describe("免費試看：未購買也看得到"),
    status: z.enum(["draft", "published"]).optional(),
    sort: z.number().int().optional(),
  };

  server.registerTool(
    "create_course",
    {
      description: "建立線上課程（預設草稿）。接著 add_lesson 加單元，再 update_course 上架（publish＋confirm）。購買走既有訂單＋付款，付款成功才自動開通。需要 classes:write。",
      inputSchema: { site, confirm, ...courseFields },
      annotations: WRITE,
    },
    wrap(async (a) => courses.createCourse(ctx, a)),
  );

  server.registerTool(
    "update_course",
    {
      description: "修改課程（標題、介紹、封面、價格、上架／下架）。改已上架課程或上架／下架需要 publish＋confirm。已開通的學員不受價格調整影響。需要 classes:write。",
      inputSchema: { site, courseId: z.string().optional(), slug: z.string().optional(), confirm, patch: z.object(courseFields).partial() },
      annotations: WRITE,
    },
    wrap(async (a) => courses.updateCourse(ctx, a)),
  );

  server.registerTool(
    "add_lesson",
    {
      description: "為課程新增單元（影片＋文字＋附件，可設免費試看）。未開通者在伺服器端就拿不到付費單元的影片網址與內容。課程已上架時新增公開單元需要 publish＋confirm。需要 classes:write。",
      inputSchema: { site, courseId: z.string().optional(), courseSlug: z.string().optional(), confirm, ...lessonFields },
      annotations: WRITE,
    },
    wrap(async (a) => courses.addLesson(ctx, a)),
  );

  server.registerTool(
    "update_lesson",
    {
      description: "修改單元（標題、影片、內容、附件、試看、上下架、排序）。課程已上架時需要 publish＋confirm。需要 classes:write。",
      inputSchema: { site, lessonId: z.string(), confirm, patch: z.object(lessonFields).partial() },
      annotations: WRITE,
    },
    wrap(async (a) => courses.updateLesson(ctx, a)),
  );

  server.registerTool(
    "list_courses",
    {
      description: "列出課程、單元（是否有影片、試看）與開通人數。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => courses.listCourses(ctx, a)),
  );

  server.registerTool(
    "grant_course",
    {
      description: "手動為會員開通課程（不經過付款，例如線下收款、贈送）。會員要先註冊。同一人重複開通不會重複。必須 confirm: true。需要 attendees:write。",
      inputSchema: { site, courseId: z.string().optional(), courseSlug: z.string().optional(), memberId: z.string().optional(), email: z.string().optional(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => courses.grantCourse(ctx, a)),
  );

  server.registerTool(
    "revoke_course",
    {
      description: "撤銷會員的課程存取權（不會自動退款）。必須 confirm: true。需要 attendees:write。",
      inputSchema: { site, courseId: z.string().optional(), courseSlug: z.string().optional(), memberId: z.string().optional(), email: z.string().optional(), reason: z.string().optional(), confirm },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => courses.revokeCourse(ctx, a)),
  );

  server.registerTool(
    "list_enrollments",
    {
      description: "課程學員（email 遮罩）：狀態 active／revoked、來源 order／manual／free、訂單、完成單元數。需要 attendees:read。",
      inputSchema: { site, courseId: z.string().optional(), courseSlug: z.string().optional(), status: z.enum(["active", "revoked"]).optional() },
      annotations: RO,
    },
    wrap(async (a) => courses.listEnrollments(ctx, a)),
  );
}
