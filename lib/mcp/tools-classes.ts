import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as events from "../services/events";

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
}
