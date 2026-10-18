import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as gb from "../services/groupbuy";

/**
 * 第八批 MCP 工具（group-buy 團購）：只做參數宣告與轉送，邏輯全在 lib/services/groupbuy.ts。
 * 由 lib/mcp/tools.ts 的 registerTools 呼叫。
 */
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

const site = z.string().optional().describe("網站 slug（租戶 token 可省略；平台 token 必填）");
const confirm = z.boolean().optional().describe("使用者確認後才設 true");
const gbRef = {
  groupBuyId: z.string().optional().describe("團購 id（list_group_buys）"),
  slug: z.string().optional().describe("或用團購 slug"),
};
const item = z.object({
  productId: z.string().describe("商品 id（list_products）"),
  variantId: z.string().nullable().optional().describe("有規格的商品要指定規格 id（每個規格一個團購品項）"),
  price: z.number().int().describe("團購價（新台幣整數，可低於一般售價；結帳一律以這個價格計算）"),
  quota: z.number().int().nullable().optional().describe("這個品項的團購限量（null＝不限；下單時原子扣減，不會超賣）"),
});
const pickup = z.object({ id: z.string().describe("自取點代號，例如 huashan"), name: z.string(), address: z.string(), hours: z.string().optional() });
const gbFields = {
  title: z.string().describe("團名"),
  descriptionMd: z.string().optional().describe("說明（Markdown）"),
  coverUrl: z.string().nullable().optional(),
  startsAt: z.string().nullable().optional().describe("開團時間 ISO（含時區，例如 2026-11-01T10:00:00+08:00）；不帶＝上架即開團"),
  endsAt: z.string().describe("截止時間 ISO（含時區）；截止後自動結團"),
  minQty: z.number().int().nullable().optional().describe("成團門檻（總件數）；未達門檻截止時自動取消所有訂單並通知"),
  pickupPoints: z.array(pickup).optional().describe("到店自取點（例如小時光門市），客人選了免運"),
  shippingMethodIds: z.array(z.string()).nullable().optional().describe("允許的 shipping 模組運送方式 id（不帶＝全部）"),
  items: z.array(item).describe("團購品項"),
  status: z.enum(["draft", "published"]).optional().describe("published＝直接開團（需 publish scope＋confirm）"),
};

export function registerGroupBuyTools(server: McpServer, ctx: ServiceContext, wrap: Wrap) {
  server.registerTool(
    "create_group_buy",
    {
      description: "建立團購（團名、開團／截止、團購價與每品項限量、成團門檻、自取點、允許的運送方式）。預設草稿；status: published 直接開團需要 publish scope＋confirm。團購頁 /s/<slug>/groupbuy/<團購 slug>。需要 commerce:write。",
      inputSchema: { site, slug: z.string().describe("團購網址代號（小寫英數與連字號）"), ...gbFields, confirm },
      annotations: WRITE,
    },
    wrap(async (a) => gb.createGroupBuy(ctx, a)),
  );
  server.registerTool(
    "update_group_buy",
    {
      description: "修改團購（patch 只帶要改的欄位；items 是整份取代：同商品＋規格沿用原品項，已售的品項不能移除、限量不能低於已售）。上架、改開團中的團購、下架需要 publish scope＋confirm；已結團的不能改。需要 commerce:write。",
      inputSchema: { site, ...gbRef, patch: z.object({ slug: z.string().optional(), ...Object.fromEntries(Object.entries(gbFields).map(([k, v]) => [k, (v as z.ZodType).optional()])) }).describe("要改的欄位"), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => gb.updateGroupBuy(ctx, a as never)),
  );
  server.registerTool(
    "duplicate_group_buy",
    {
      description: "一鍵複製既有團購為新草稿（品項、團購價、限量、自取點、團主分潤都帶過去；已售歸零；截止預設 7 天後）。改完時間再用 update_group_buy 上架。需要 commerce:write。",
      inputSchema: { site, ...gbRef, newSlug: z.string().optional(), title: z.string().optional() },
      annotations: WRITE,
    },
    wrap(async (a) => gb.duplicateGroupBuy(ctx, a)),
  );
  server.registerTool(
    "list_group_buys",
    { description: "列出團購（狀態、截止、已售件數、是否成團、品項剩餘量）。截止的會先自動結團。需要 site:read。", inputSchema: { site, status: z.enum(["draft", "published", "closed", "failed", "cancelled"]).optional() }, annotations: RO },
    wrap(async (a) => gb.listGroupBuys(ctx, a)),
  );
  server.registerTool(
    "get_group_buy",
    { description: "看單一團購：品項（團購價、限量、已售、剩餘）、訂單統計、團主與專屬連結。需要 site:read。", inputSchema: { site, ...gbRef }, annotations: RO },
    wrap(async (a) => gb.getGroupBuy(ctx, a)),
  );
  server.registerTool(
    "invite_leader",
    {
      description: "邀請（＝核准）團主：同 email 同站一位團主；帶 groupBuyId 時設定這一團的分潤（commissionPercent 0–50％ 或 commissionFixed 每單 NT$，擇一；分潤基數＝扣掉所有折扣後的商品實付，取消沖回）。回傳團主專屬連結與簽章報表連結（報表只顯示遮罩後的買家）。rotateReportLink: true 讓舊報表連結失效；notify: true 寄信給團主。需要 marketing:write。",
      inputSchema: { site, groupBuyId: z.string().optional(), name: z.string(), email: z.string(), commissionPercent: z.number().optional(), commissionFixed: z.number().int().optional(), rotateReportLink: z.boolean().optional(), notify: z.boolean().optional(), disable: z.boolean().optional().describe("true＝停用團主（連結與報表失效）") },
      annotations: WRITE,
    },
    wrap(async (a) => gb.inviteLeader(ctx, a)),
  );
  server.registerTool(
    "list_group_buy_orders",
    { description: "列出某團購的訂單（狀態、金額、品項、運送方式、團主、分潤、匯款帳號末五碼；只含姓名，電話地址請用 export_shipping）。需要 orders:read。", inputSchema: { site, ...gbRef, status: z.enum(["pending_payment", "paid", "fulfilled", "cancelled"]).optional(), leaderId: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() }, annotations: RO },
    wrap(async (a) => gb.listGroupBuyOrders(ctx, a)),
  );
  server.registerTool(
    "import_bank_statement",
    {
      description: "匯入銀行明細 CSV（標題列：日期、金額、帳號末五碼、備註；日期 YYYY-MM-DD；只收存入的正數金額）→ 依「金額＋末五碼（或備註含訂單編號）＋時間窗」比對待付款的匯款訂單，🔴 只產生『建議配對』、不改任何訂單。多重候選不自動配。以 = + - @ 開頭的儲存格整份拒絕（防 CSV injection）。同一份重複匯入不會重複建立。之後用 confirm_bank_matches 確認。需要 orders:write。",
      inputSchema: { site, csv: z.string().describe("CSV 全文（UTF-8）"), filename: z.string().optional() },
      annotations: WRITE,
    },
    wrap(async (a) => gb.importBankStatement(ctx, a)),
  );
  server.registerTool(
    "confirm_bank_matches",
    {
      description: "確認銀行明細配對：matchIds 的訂單標記為已收款（單一交易：配對已確認＋訂單已付款；一筆明細／一張單只能確認一次）並跑付款成功流程（寄信、分潤、發票…）；rejectMatchIds 拒絕建議。🔴 必須先讓使用者逐筆核對，再帶 confirm: true。需要 orders:write。",
      inputSchema: { site, matchIds: z.array(z.string()).optional(), rejectMatchIds: z.array(z.string()).optional(), confirm },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => gb.confirmBankMatches(ctx, a)),
  );
  server.registerTool(
    "close_group_buy",
    {
      description: "提早結團（截止時間改為現在）：達門檻（或沒設門檻）→ 成團並通知；未達門檻 → 🔴 取消所有訂單並通知（已付款的需退款）。結團後不能再下單。必須 confirm: true。需要 orders:write。截止時間到了系統也會自動結團（每日 cron＋讀取時）。",
      inputSchema: { site, ...gbRef, confirm },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => gb.closeGroupBuy(ctx, a)),
  );
  server.registerTool(
    "export_shipping",
    {
      description: "出貨報表／物流匯出 CSV（已付款的團購單：收件人、電話、地址、超商門市、自取點、品項、團主）。🔴 含個資：每次匯出記錄於個資查看紀錄（誰、何時、幾筆）；CSV 已防公式注入。includeFulfilled: true 也帶已出貨。需要 orders:read。",
      inputSchema: { site, ...gbRef, includeFulfilled: z.boolean().optional(), reason: z.string().optional().describe("匯出用途（記錄用）") },
      annotations: RO,
    },
    wrap(async (a) => gb.exportShipping(ctx, a)),
  );
  server.registerTool(
    "create_group_buy_shipments",
    {
      description: "批次建立綠界物流單：已付款、選綠界物流、還沒有物流單的團購單逐單建立（同一訂單只會有一張有效物流單＝重跑冪等）。每次最多 50 張，remaining 有剩就再呼叫。必須 confirm: true。需要 shipping:write。",
      inputSchema: { site, ...gbRef, limit: z.number().int().optional(), confirm },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => gb.createGroupBuyShipments(ctx, a)),
  );
}
