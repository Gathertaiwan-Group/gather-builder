import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as loyalty from "../services/loyalty";

/**
 * 第五、六批 MCP 工具（會員經營、內容與在地）：只做參數宣告與轉送，邏輯全在 lib/services。
 * 由 lib/mcp/tools.ts 的 registerTools 呼叫。
 */

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const site = z.string().optional().describe("網站 slug（租戶 token 可省略；平台 token 必填）");
const confirm = z.boolean().optional().describe("使用者確認後才設 true");
const memberRef = {
  memberId: z.string().optional().describe("會員 id（list_members）"),
  email: z.string().optional().describe("或用會員 email"),
};

export function registerContentTools(server: McpServer, ctx: ServiceContext, wrap: Wrap) {
  /* ------------------------------------------------------------ 會員點數＋等級（loyalty） */

  server.registerTool(
    "get_member_points",
    {
      description: "查會員點數：餘額、可用（扣掉已到期）、即將到期的批次（FIFO）、目前等級與期間消費、最近 30 筆帳本（只增不改）。需要 members:read。",
      inputSchema: { site, ...memberRef },
      annotations: RO,
    },
    wrap(async (a) => loyalty.getMemberPoints(ctx, a)),
  );

  server.registerTool(
    "adjust_points",
    {
      description: "店主手動加／扣會員點數（例如補償、活動贈點）。amount 正數加點（依設定天數到期）、負數扣點（不能扣超過可用點數）；reason 必填。寫入只增不改的帳本。**必須** confirm: true。需要 members:write。",
      inputSchema: { site, ...memberRef, amount: z.number().int().describe("點數（正＝加、負＝扣）"), reason: z.string().describe("理由（會記在帳本與稽核）"), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => loyalty.adjustPoints(ctx, a)),
  );

  server.registerTool(
    "list_tiers",
    {
      description: "會員等級：已發布與草稿的等級設定（門檻、賺點倍率、等級折扣）、各等級人數、計算期間。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => loyalty.listTiers(ctx, a)),
  );

  server.registerTool(
    "update_tiers",
    {
      description:
        "整份取代會員等級（進草稿，publish_site 後生效）。每級：id（小寫英數代碼，比對鍵）、name、minSpend（期間內已付款商品淨額門檻）、multiplier（賺點倍率 1–10）、discountPercent（等級折扣 0–50%）、perks（說明）。windowMonths 可改計算期間（0＝累計）。賺點規則等其他設定用 configure_module loyalty。需要 modules:write。",
      inputSchema: {
        site,
        tiers: z.array(z.object({ id: z.string(), name: z.string(), minSpend: z.number().int(), multiplier: z.number().optional(), discountPercent: z.number().int().optional(), perks: z.string().optional() })),
        windowMonths: z.number().int().optional(),
      },
      annotations: WRITE,
    },
    wrap(async (a) => loyalty.updateTiers(ctx, a)),
  );
}
