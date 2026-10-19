import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceError, type ServiceContext } from "../services/context";
import * as billing from "../services/platform-billing";
import * as domains from "../services/domains";
import { geminiFromEnv } from "../ai/gemini";
import { THEME_PRESETS } from "../themes";

/** 第九批 MCP 工具（平台收費、網址）：只做參數宣告與轉送，邏輯在 lib/services/platform-billing.ts、domains.ts */
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;
const site = z.string().optional().describe("網站 slug（租戶 token 可省略；平台 token 必填）");

export function registerPlatformTools(server: McpServer, ctx: ServiceContext, wrap: Wrap) {
  const deps = (): billing.PlatformDeps => ({ store: ctx.store, baseUrl: ctx.baseUrl, previewSecret: ctx.previewSecret, sendMail: ctx.sendMail, gemini: geminiFromEnv() });
  const local = () => ["localhost", "127.0.0.1"].includes(new URL(ctx.baseUrl).hostname);

  server.registerTool(
    "get_build_quote",
    {
      description:
        "開站／加購報價（由伺服器依模組註冊表計算）：依模組清單自動帶入依賴，回傳每個模組的建置費與月費、是否為依賴自動帶入、建置費合計、月費合計、首次付款（建置費＋第一個月）。帶 site 時只算該網站還沒有的模組（加購）。不需特定 scope。",
      inputSchema: { modules: z.array(z.string()).describe("模組 id（list_modules）"), site },
      annotations: RO,
    },
    wrap(async (a) => {
      if (!a.site && !ctx.actor.tenantId) return billing.getBuildQuote({ modules: a.modules });
      const { resolveTenant } = await import("../services/context");
      const t = await resolveTenant(ctx, a.site);
      const b = await ctx.store.getTenantBilling(t.id);
      const enabled = (await ctx.store.listTenantModules(t.id)).filter((m) => m.status !== "disabled").map((m) => m.module_id);
      return billing.getBuildQuote({ modules: a.modules, existing: [...new Set([...(b?.modules ?? []), ...enabled])], existingMonthly: b?.monthly_amount ?? 0 });
    }),
  );

  server.registerTool(
    "create_build_checkout",
    {
      description:
        "建立平台訂單並回傳付款連結 checkoutUrl（🔴 agent 不能代付：請把連結交給使用者本人開啟、確認金額後付款）。兩種用法：① 開新站：帶 brandName、slug（網址代號）、email（付款後寄店主後台邀請）、modules、themePreset；② 加購：帶 site（或用網站 token）與 modules，只收還沒有的模組。價格一律由伺服器計算。付款成功後自動開站／開通；用 get_build_status 查進度。平台金流沒設定時會回「尚未開放付款」。",
      inputSchema: {
        modules: z.array(z.string()),
        site,
        brandName: z.string().optional(),
        slug: z.string().optional().describe("新站的網址代號（3–40 字小寫英數與 -）"),
        email: z.string().optional().describe("新站店主的 email"),
        themePreset: z.enum(THEME_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(),
      },
      annotations: WRITE,
    },
    wrap(async (a) => {
      if (a.site || ctx.actor.tenantId) {
        const r = await billing.createAddonOrder(ctx, { site: a.site, modules: a.modules }, { allowSandbox: local() });
        return { orderNo: r.orderNo, checkoutUrl: r.statusUrl, quote: r.quote, note: "請使用者本人開啟 checkoutUrl 付款；付款後自動開通，get_build_status 可查進度。" };
      }
      if (!a.brandName || !a.slug || !a.email) throw new ServiceError("invalid", "開新站需要 brandName、slug、email");
      const r = await billing.createBuildOrder(deps(), { modules: a.modules, brandName: a.brandName, slug: a.slug, email: a.email, themePreset: a.themePreset }, { by: ctx.actor.label, allowSandbox: local() });
      return { orderNo: r.order.order_no, accessKey: r.accessKey, checkoutUrl: r.statusUrl, quote: r.quote, sandbox: r.order.sandbox, note: "請使用者本人開啟 checkoutUrl 付款（agent 不能代付）。付款後自動開站並寄店主後台邀請到 email；用 get_build_status { orderNo, accessKey } 查進度。" };
    }),
  );

  server.registerTool(
    "get_build_status",
    {
      description: "查平台訂單（開站／加購／續費）狀態：待付款、已付款、開站進度（provisionState done 時附網站與店主後台網址）。開新站的訂單要帶 create_build_checkout 回傳的 accessKey；平台 token 或該網站的 token 不用。",
      inputSchema: { orderNo: z.string(), accessKey: z.string().optional() },
      annotations: RO,
    },
    wrap(async (a) => {
      const o = await ctx.store.getPlatformOrderByNo(a.orderNo);
      const trusted = ctx.actor.scopes.includes("platform:sites") && !ctx.actor.tenantId ? true : !!o && !!ctx.actor.tenantId && o.tenant_id === ctx.actor.tenantId;
      return billing.getPlatformOrderStatus(deps(), { orderNo: a.orderNo, accessKey: a.accessKey, trusted });
    }),
  );

  server.registerTool(
    "list_domains",
    {
      description: "網站的網址：目前正式網址、是否已啟用子網域、自有網域清單與狀態（pending 等 DNS／verified 待啟用／active 正式網址）與要設定的 DNS 記錄。🔴 新增／啟用／移除自有網域只能由店主（owner）在後台操作。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => domains.listDomains(ctx, a)),
  );
}
