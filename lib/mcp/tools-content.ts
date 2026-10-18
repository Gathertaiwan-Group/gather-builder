import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as loyalty from "../services/loyalty";
import * as wallet from "../services/wallet";

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

  /* ------------------------------------------------------------ 儲值金（stored-value） */

  server.registerTool(
    "get_member_balance",
    {
      description: "查會員儲值金：餘額、可用、贈送額度到期、最近 30 筆帳本（只增不改）。需要 members:read。",
      inputSchema: { site, ...memberRef },
      annotations: RO,
    },
    wrap(async (a) => wallet.getMemberBalance(ctx, a)),
  );

  server.registerTool(
    "adjust_balance",
    {
      description: "店主手動增減會員儲值金（例如線下退款後扣回、補償）。amount 正數增加、負數扣除（不能超過可用）；reason 必填。寫入只增不改的帳本。**必須** confirm: true。需要 members:write。",
      inputSchema: { site, ...memberRef, amount: z.number().int().describe("NT$（正＝增加、負＝扣除）"), reason: z.string(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => wallet.adjustBalance(ctx, a)),
  );

  const planFields = {
    name: z.string().describe("方案名稱，例如「儲 1000 送 100」"),
    payAmount: z.number().int().describe("客人付多少（NT$，≥ 30）"),
    bonusAmount: z.number().int().optional().describe("另外贈送多少額度（預設 0）"),
    bonusExpireDays: z.number().int().nullable().optional().describe("贈送額度幾天後到期（不填＝不到期；本金不到期）"),
    description: z.string().optional(),
    status: z.enum(["draft", "published"]).optional().describe("預設 draft；published 需要 publish scope＋confirm"),
    sort: z.number().int().optional(),
  };

  server.registerTool(
    "create_topup_plan",
    {
      description: "建立儲值方案（付 X 得 X＋贈送）。購買走既有訂單＋付款，付款真正成功才入帳（sandbox 不入帳）。直接上架需 publish＋confirm。🔴 儲值金屬預收款，正式上線前請店家確認是否需履約保證／信託。需要 commerce:write。",
      inputSchema: { site, ...planFields, confirm },
      annotations: WRITE,
    },
    wrap(async (a) => wallet.createTopupPlan(ctx, a)),
  );

  server.registerTool(
    "update_topup_plan",
    {
      description: "修改／上架／下架儲值方案（已上架或要上架需 publish＋confirm）。已售出的儲值不受影響。需要 commerce:write。",
      inputSchema: { site, planId: z.string(), patch: z.object(planFields).partial(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => wallet.updateTopupPlan(ctx, a)),
  );

  server.registerTool(
    "list_topup_plans",
    {
      description: "儲值方案列表（含草稿）。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => wallet.listTopupPlans(ctx, a)),
  );
}
