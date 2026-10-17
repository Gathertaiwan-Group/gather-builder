import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceError, type ServiceContext } from "../services/context";
import * as sites from "../services/sites";
import * as modules from "../services/modules";
import * as publish from "../services/publish";
import * as posts from "../services/posts";
import * as inquiries from "../services/inquiries";
import * as tokens from "../services/tokens";
import { THEME_PRESETS } from "../themes";
import { TENANT_SCOPES } from "../scopes";

/**
 * MCP 工具層：只做參數宣告與轉送，所有邏輯（權限、隔離、驗證、稽核）都在 lib/services。
 * 後台呼叫的是同一批服務函式。
 */

const MAX_TEXT = 200_000;

function ok(value: unknown) {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n\n⚠️ 輸出超過 ${MAX_TEXT} 字已截斷，請縮小查詢範圍。`;
  return { content: [{ type: "text" as const, text }] };
}

function fail(e: unknown) {
  if (e instanceof ServiceError) {
    return { content: [{ type: "text" as const, text: `[${e.code}] ${e.message}` }], isError: true };
  }
  console.error("[mcp] tool error", e);
  return { content: [{ type: "text" as const, text: `[internal] 伺服器錯誤：${e instanceof Error ? e.message.slice(0, 300) : "未知"}` }], isError: true };
}

const site = z
  .string()
  .optional()
  .describe("網站 slug。用租戶 token 時可省略（自動指向自己的網站，帶別的 slug 會被拒）；用平台 token 時必填。");
const path = z.string().describe("頁面路徑，例如 \"/\"（首頁）、\"/about\"。用 get_site 看現有頁面。");
const props = z.record(z.string(), z.unknown());

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

type Handler<A> = (args: A) => Promise<unknown>;

export function registerTools(server: McpServer, ctx: ServiceContext) {
  const wrap =
    <A>(fn: Handler<A>) =>
    async (args: A) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        return fail(e);
      }
    };

  /* ------------------------------------------------------------ 平台 */

  server.registerTool(
    "list_modules",
    {
      description:
        "列出平台所有可用模組（id、名稱、說明、建置費與月費（新台幣）、依賴、提供的區塊類型）。開站或加功能前先用這個決定要開哪些模組。不需特定 scope。",
      inputSchema: {},
      annotations: RO,
    },
    wrap(async () => sites.listModules()),
  );

  server.registerTool(
    "create_site",
    {
      description:
        "建立新網站（租戶）：開啟 core 與指定模組（依賴自動帶入）、建立預設首頁草稿，回傳 slug、預覽網址、以及一組該網站專用 token（原文只出現這一次，之後操作此網站請改用它）。網站建立後尚未上線，需 publish_site。需要 scope platform:sites（僅平台 token）。",
      inputSchema: {
        slug: z.string().describe("網址代號，3–40 字小寫英數與連字號，例如 \"lin-bakery\"。前台網址為 /s/<slug>"),
        name: z.string().describe("網站／品牌名稱，例如「林記烘焙」"),
        modules: z.array(z.string()).optional().describe("要開的模組 id（用 list_modules 查），預設 [\"sections-basic\"]。core 一律會開。"),
        themePreset: z.enum(THEME_PRESETS.map((p) => p.id) as [string, ...string[]]).optional().describe(`主題：${THEME_PRESETS.map((p) => `${p.id}=${p.name}`).join("、")}`),
        test: z.boolean().optional().describe("測試用網站（不被搜尋引擎收錄、後台標示 test）"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => sites.createSite(ctx, a)),
  );

  server.registerTool(
    "issue_site_token",
    {
      description: `為指定網站發行一組新 token（可限縮 scope，例如只給 site:read 給唯讀助理）。原文只回傳一次。可用 scope：${TENANT_SCOPES.join(", ")}。需要 platform:sites（僅平台 token）。`,
      inputSchema: {
        site: z.string().describe("網站 slug"),
        name: z.string().describe("用途說明，例如「客戶的 Claude」"),
        scopes: z.array(z.string()).describe("scope 清單"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => tokens.issueToken(ctx, a)),
  );

  /* ------------------------------------------------------------ 讀取 */

  server.registerTool(
    "get_site",
    {
      description: "網站總覽：模組狀態、主題、導覽、各頁面與區塊 id/類型（草稿）、目前已發布版本、草稿是否有未發布變更。改內容前先呼叫這個。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => sites.getSite(ctx, a.site)),
  );

  server.registerTool(
    "get_page",
    {
      description: "取得草稿中某一頁的完整內容（標題、SEO、每個區塊的 id、type、props）。update_section 前用它看目前的 props。需要 site:read。",
      inputSchema: { site, path },
      annotations: RO,
    },
    wrap(async (a) => sites.getPage(ctx, a)),
  );

  server.registerTool(
    "list_section_types",
    {
      description: "列出此網站「已啟用模組」可用的區塊類型，含 props 的 JSON Schema 與範例。add_section 前務必先看，props 必須符合 schema。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => sites.listSectionTypes(ctx, a.site)),
  );

  /* ------------------------------------------------------------ 內容（草稿） */

  server.registerTool(
    "add_section",
    {
      description: "在草稿的某頁加入一個區塊。type 必須屬於已啟用模組；props 依 list_section_types 的 schema。回傳新區塊 id。只改草稿，不會上線。需要 content:write。",
      inputSchema: {
        site,
        path,
        type: z.string().describe("區塊類型，例如 hero、rich_text、contact_form"),
        props: props.optional().describe("區塊內容；省略則用空物件（必填欄位缺漏會被拒）"),
        position: z.number().int().optional().describe("插入位置（0 = 最上面），省略則加在最後"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => sites.addSection(ctx, a)),
  );

  server.registerTool(
    "update_section",
    {
      description: "修改草稿中某區塊的 props。預設為淺層合併（只傳要改的欄位）；replace: true 則整份取代。合併後會依 schema 驗證。需要 content:write。",
      inputSchema: {
        site,
        path,
        sectionId: z.string().describe("區塊 id（s_ 開頭，從 get_site/get_page 取得）"),
        props: props.describe("要更新的欄位"),
        replace: z.boolean().optional().describe("true = 用 props 整份取代"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => sites.updateSection(ctx, a)),
  );

  server.registerTool(
    "remove_section",
    {
      description: "從草稿某頁移除一個區塊。需要 content:write。",
      inputSchema: { site, path, sectionId: z.string() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => sites.removeSection(ctx, a)),
  );

  server.registerTool(
    "move_section",
    {
      description: "調整區塊順序：把 sectionId 移到 toIndex（0 = 最上面）。需要 content:write。",
      inputSchema: { site, path, sectionId: z.string(), toIndex: z.number().int().min(0) },
      annotations: WRITE,
    },
    wrap(async (a) => sites.moveSection(ctx, a)),
  );

  server.registerTool(
    "upsert_page",
    {
      description: "新增或更新草稿頁面（標題、SEO）。新頁面沒有區塊，之後用 add_section 加。路徑 /blog 由部落格模組保留。需要 content:write。",
      inputSchema: {
        site,
        path,
        title: z.string().describe("頁面標題"),
        seo: z
          .object({ title: z.string().optional(), description: z.string().optional(), ogImage: z.string().optional() })
          .optional()
          .describe("SEO：title、description、ogImage（https 圖片網址）"),
        addToNav: z.boolean().optional().describe("true = 順便加入導覽列"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => sites.upsertPage(ctx, a)),
  );

  server.registerTool(
    "delete_page",
    {
      description: "從草稿刪除頁面（首頁 / 不能刪），同時移除指向它的導覽項目。需要 content:write。",
      inputSchema: { site, path },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => sites.deletePage(ctx, a)),
  );

  server.registerTool(
    "update_nav",
    {
      description: "整份取代導覽列（草稿）。href 可為站內路徑（/about、/blog）、#錨點或外部 https 連結。需要 content:write。",
      inputSchema: {
        site,
        items: z.array(z.object({ label: z.string(), href: z.string() })).max(12).describe("導覽項目，依顯示順序"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => sites.updateNav(ctx, a)),
  );

  /* ------------------------------------------------------------ 設計 */

  server.registerTool(
    "update_theme",
    {
      description: `修改主題（草稿）。preset：${THEME_PRESETS.map((p) => `${p.id}（${p.name}：${p.description}）`).join("；")}。overrides 可覆寫個別變數：primary/secondary/background/surface/text/muted（#RRGGBB）、fontHeading/fontBody（字體堆疊）、radius（如 12px）。需要 design:write。`,
      inputSchema: {
        site,
        preset: z.string().optional(),
        overrides: z.record(z.string(), z.string()).optional(),
        resetOverrides: z.boolean().optional().describe("true = 先清除所有覆寫"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => sites.updateTheme(ctx, a)),
  );

  /* ------------------------------------------------------------ 模組 */

  server.registerTool(
    "enable_module",
    {
      description: "啟用模組（依賴自動帶入）。需要設定才能運作的模組（例如 line 需 lineUrl）會是 pending_setup，可同時帶 config 或之後 configure_module。需要 modules:write。",
      inputSchema: { site, moduleId: z.string(), config: z.record(z.string(), z.unknown()).optional() },
      annotations: WRITE,
    },
    wrap(async (a) => modules.enableModule(ctx, a)),
  );

  server.registerTool(
    "disable_module",
    {
      description: "停用模組。core 不能停；被其他已啟用模組依賴、或草稿中還有它的區塊時會被拒並說明原因。需要 modules:write。",
      inputSchema: { site, moduleId: z.string() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => modules.disableModule(ctx, a)),
  );

  server.registerTool(
    "configure_module",
    {
      description:
        "設定模組（依模組的 settingsSchema 驗證，立即生效、不經草稿）。例：core {ga4MeasurementId, siteDescription, defaultOgImage, footerText}；contact-form {notifyEmail, rateLimitPerHour}；line {lineUrl, floating, floatingLabel}；blog {listTitle, postsPerPage}。預設與現有設定合併。需要 modules:write。",
      inputSchema: {
        site,
        moduleId: z.string(),
        config: z.record(z.string(), z.unknown()),
        replace: z.boolean().optional().describe("true = 整份取代"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => modules.configureModule(ctx, a)),
  );

  /* ------------------------------------------------------------ 部落格／作品集 */

  server.registerTool(
    "create_post",
    {
      description: "新增文章（需 blog 模組）。status 預設 draft；設 published 會立即上線（文章不經網站草稿/發布流程）。bodyMd 為 Markdown（不支援原始 HTML）。需要 content:write。",
      inputSchema: {
        site,
        slug: z.string().describe("文章網址代號，小寫英數與連字號，例如 \"open-house-2026\""),
        title: z.string(),
        excerpt: z.string().optional().describe("摘要（列表顯示）"),
        bodyMd: z.string().optional().describe("內文 Markdown"),
        coverUrl: z.string().optional().describe("封面圖 https 網址"),
        status: z.enum(["draft", "published"]).optional(),
        publishedAt: z.string().optional().describe("ISO 8601 發布時間，未來時間 = 排程"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => posts.createPost(ctx, a)),
  );

  server.registerTool(
    "update_post",
    {
      description: "修改文章（用 postId 或 slug 指定），只傳要改的欄位。需要 content:write。",
      inputSchema: {
        site,
        postId: z.string().optional(),
        slug: z.string().optional().describe("目前的 slug（與 postId 二擇一）"),
        patch: z
          .object({
            slug: z.string().optional(),
            title: z.string().optional(),
            excerpt: z.string().optional(),
            bodyMd: z.string().optional(),
            coverUrl: z.string().optional(),
            status: z.enum(["draft", "published"]).optional(),
            publishedAt: z.string().optional(),
          })
          .describe("要修改的欄位"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => posts.updatePost(ctx, a)),
  );

  server.registerTool(
    "list_posts",
    {
      description: "列出文章（id、slug、標題、狀態、發布時間、摘要）。需要 site:read。",
      inputSchema: {
        site,
        status: z.enum(["draft", "published"]).optional(),
        limit: z.number().int().optional().describe("預設 20，最多 50"),
        offset: z.number().int().optional(),
      },
      annotations: RO,
    },
    wrap(async (a) => posts.listPosts(ctx, a)),
  );

  server.registerTool(
    "create_portfolio_item",
    {
      description: "新增作品集項目（需 portfolio 模組），會出現在 portfolio_grid 區塊。需要 content:write。",
      inputSchema: {
        site,
        title: z.string(),
        description: z.string().optional(),
        imageUrl: z.string().describe("作品圖 https 網址"),
        linkUrl: z.string().optional(),
        tags: z.array(z.string()).optional(),
        sort: z.number().int().optional().describe("排序，小的在前"),
        status: z.enum(["draft", "published"]).optional(),
      },
      annotations: WRITE,
    },
    wrap(async (a) => posts.createPortfolioItem(ctx, a)),
  );

  server.registerTool(
    "update_portfolio_item",
    {
      description: "修改作品集項目，只傳要改的欄位。需要 content:write。",
      inputSchema: {
        site,
        itemId: z.string(),
        patch: z.object({
          title: z.string().optional(),
          description: z.string().optional(),
          imageUrl: z.string().optional(),
          linkUrl: z.string().optional(),
          tags: z.array(z.string()).optional(),
          sort: z.number().int().optional(),
          status: z.enum(["draft", "published"]).optional(),
        }),
      },
      annotations: WRITE,
    },
    wrap(async (a) => posts.updatePortfolioItem(ctx, a)),
  );

  server.registerTool(
    "list_portfolio_items",
    {
      description: "列出作品集項目（id、標題、狀態、標籤）。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => posts.listPortfolioItems(ctx, a)),
  );

  /* ------------------------------------------------------------ 詢問 */

  server.registerTool(
    "list_inquiries",
    {
      description: "讀取聯絡表單收到的詢問（最新在前），含姓名、Email、電話、留言、來源頁。內容屬個資，請只轉達給網站主。需要 inquiries:read。",
      inputSchema: { site, limit: z.number().int().optional().describe("預設 20，最多 100"), status: z.enum(["new", "read", "archived"]).optional() },
      annotations: RO,
    },
    wrap(async (a) => inquiries.listInquiries(ctx, a)),
  );

  /* ------------------------------------------------------------ 發布 */

  server.registerTool(
    "preview_changes",
    {
      description: "比較草稿與目前已發布版本，回傳差異摘要、發布前驗證問題、以及約 1 小時有效的預覽網址。發布前一定要先呼叫，並把預覽網址給使用者確認。需要 site:read。",
      inputSchema: { site, path: z.string().optional().describe("預覽網址要開在哪一頁，預設 /") },
      annotations: RO,
    },
    wrap(async (a) => publish.previewChanges(ctx, a)),
  );

  server.registerTool(
    "publish_site",
    {
      description: "把目前草稿發布上線，產生新版本號。必須帶 confirm: true（代表使用者已看過 preview_changes 並同意），否則會被拒。需要 publish。",
      inputSchema: {
        site,
        confirm: z.boolean().optional().describe("使用者確認後才設 true"),
        note: z.string().optional().describe("版本備註，例如「更新春季菜單」"),
      },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => publish.publishSite(ctx, a)),
  );

  server.registerTool(
    "list_revisions",
    {
      description: "列出所有發布版本（版本號、備註、發布者、時間、是否為目前上線版本）。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => publish.listRevisions(ctx, a)),
  );

  server.registerTool(
    "rollback",
    {
      description: "把網站還原到指定版本：該版立即上線，並覆蓋目前草稿（未發布的修改會消失）。必須帶 confirm: true。需要 publish。",
      inputSchema: { site, number: z.number().int().min(1).describe("版本號（list_revisions）"), confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => publish.rollback(ctx, a)),
  );
}
