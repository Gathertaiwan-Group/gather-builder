import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as qr from "../services/qrcatalog";

/** 第八批 MCP 工具（qr-catalog）：只做參數宣告與轉送，邏輯全在 lib/services/qrcatalog.ts */
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
const site = z.string().optional().describe("網站 slug（租戶 token 可省略；平台 token 必填）");

export function registerQrTools(server: McpServer, ctx: ServiceContext, wrap: Wrap) {
  server.registerTool(
    "generate_qr_labels",
    {
      description: "為已上架商品產生 QR（每個商品一組不可預測的 10 字短碼、短連結 /s/<slug>/q/<碼>；已有就沿用）。回傳每個商品的短連結、PNG 網址、SVG（includeSvg: false 可省略），以及 A4 標籤頁網址 labelsUrl（一頁 21 張：商品名、價格、QR；1 小時有效，開啟後列印）。不帶 productIds＝全部已上架商品（最多 120）；可用 brand 篩選。需要 commerce:write。",
      inputSchema: { site, productIds: z.array(z.string()).optional(), brand: z.string().optional(), includeSvg: z.boolean().optional() },
      annotations: WRITE,
    },
    wrap(async (a) => qr.generateQrLabels(ctx, a)),
  );
  server.registerTool(
    "get_scan_report",
    {
      description: "QR 掃描報表（出海資料）：商品 × 國家 × 語言的掃描數、轉成線上訂單／海外寄送詢價的數量與轉換率（%），另附各國家合計。國家碼只來自 Vercel geo（不存 IP）。sinceDays 預設 90；可用 brand 篩選。需要 orders:read。",
      inputSchema: { site, sinceDays: z.number().int().optional(), brand: z.string().optional() },
      annotations: RO,
    },
    wrap(async (a) => qr.getScanReport(ctx, a)),
  );
  server.registerTool(
    "create_brand_report_link",
    {
      description: "為一個品牌（商品的 brand 欄位）建立唯讀報表連結（簽章、可撤銷、會到期 expiresInDays 1–365，預設 30）：品牌只看得到自家商品的掃描、轉換與銷量，沒有任何顧客資料。拿到連結的人都看得到：必須先讓使用者確認，再帶 confirm: true。需要 marketing:write。",
      inputSchema: { site, brand: z.string(), label: z.string().optional(), expiresInDays: z.number().int().optional(), confirm: z.boolean().optional() },
      annotations: WRITE,
    },
    wrap(async (a) => qr.createBrandReportLink(ctx, a)),
  );
  server.registerTool(
    "revoke_brand_report_link",
    { description: "立即撤銷品牌報表連結（之後開啟一律 404）。需要 marketing:write。", inputSchema: { site, linkId: z.string() }, annotations: WRITE },
    wrap(async (a) => qr.revokeBrandReportLink(ctx, a)),
  );
  server.registerTool(
    "list_brand_report_links",
    { description: "列出品牌報表連結（品牌、到期、是否已撤銷）。需要 marketing:write。", inputSchema: { site }, annotations: RO },
    wrap(async (a) => qr.listBrandReportLinks(ctx, a)),
  );
}
