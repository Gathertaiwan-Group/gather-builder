import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServiceError, type ServiceContext } from "../services/context";
import * as sites from "../services/sites";
import * as modules from "../services/modules";
import * as publish from "../services/publish";
import * as posts from "../services/posts";
import * as inquiries from "../services/inquiries";
import * as tokens from "../services/tokens";
import * as members from "../services/members";
import * as shop from "../services/shop";
import * as orders from "../services/orders";
import * as invoices from "../services/invoices";
import * as shipping from "../services/shipping";
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
  // 內部錯誤（可能含 SQL／約束名）只記在 server log，回給客戶端的是通用訊息＋追查碼
  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[mcp] tool error ref=${ref}`, e);
  return { content: [{ type: "text" as const, text: `[internal] 伺服器發生錯誤，請稍後再試（追查碼 ${ref}）` }], isError: true };
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
      description: "新增或更新草稿頁面（標題、SEO）。新頁面沒有區塊，之後用 add_section 加。路徑 /blog、/shop、/checkout、/account、/orders、/api 由模組保留。需要 content:write。",
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
        "設定模組（依模組的 settingsSchema 驗證）。設定存進草稿，preview_changes → publish_site 後才對外生效。例：core {ga4MeasurementId, siteDescription, defaultOgImage, footerText}；contact-form {notifyEmail, rateLimitPerHour}；line {lineUrl, floating, floatingLabel}；blog {listTitle, postsPerPage}；members {allowRegistration}；shop {shippingFee, freeShippingThreshold, ownerEmail, orderPrefix, orderExpireHours, allowGuestCheckout, offlineTransfer:{enabled, instructions}, pchomepay}（金流金鑰不在這裡，只能從後台輸入）。預設與現有設定合併。需要 modules:write。",
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
      description:
        "新增文章（需 blog 模組）。status 預設 draft（不公開）。設 published 會立即上線，因此另外需要 publish scope 並帶 confirm: true（使用者確認後）。bodyMd 為 Markdown（不支援原始 HTML）。需要 content:write。",
      inputSchema: {
        site,
        slug: z.string().describe("文章網址代號，小寫英數與連字號，例如 \"open-house-2026\""),
        title: z.string(),
        excerpt: z.string().optional().describe("摘要（列表顯示）"),
        bodyMd: z.string().optional().describe("內文 Markdown"),
        coverUrl: z.string().optional().describe("封面圖 https 網址"),
        status: z.enum(["draft", "published"]).optional(),
        publishedAt: z.string().optional().describe("ISO 8601 發布時間，未來時間 = 排程"),
        confirm: z.boolean().optional().describe("status 為 published 時必填 true（使用者已確認上線）"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => posts.createPost(ctx, a)),
  );

  server.registerTool(
    "update_post",
    {
      description:
        "修改文章（用 postId 或 slug 指定），只傳要改的欄位。草稿文章只需 content:write；若文章已公開、或要上架／下架，會立即影響線上，需要 publish scope 並帶 confirm: true。",
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
        confirm: z.boolean().optional().describe("影響已公開內容時必填 true"),
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
      description:
        "新增作品集項目（需 portfolio 模組）。status 預設 draft；設 published 才會出現在 portfolio_grid，需要 publish scope 並帶 confirm: true。需要 content:write。",
      inputSchema: {
        site,
        title: z.string(),
        description: z.string().optional(),
        imageUrl: z.string().describe("作品圖 https 網址"),
        linkUrl: z.string().optional(),
        tags: z.array(z.string()).optional(),
        sort: z.number().int().optional().describe("排序，小的在前"),
        status: z.enum(["draft", "published"]).optional(),
        confirm: z.boolean().optional().describe("status 為 published 時必填 true"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => posts.createPortfolioItem(ctx, a)),
  );

  server.registerTool(
    "update_portfolio_item",
    {
      description: "修改作品集項目，只傳要改的欄位。已公開的作品或上架／下架需要 publish scope 並帶 confirm: true。需要 content:write。",
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
        confirm: z.boolean().optional().describe("影響已公開內容時必填 true"),
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

  /* ------------------------------------------------------------ 會員（members 模組） */

  server.registerTool(
    "list_members",
    {
      description: "列出此網站的會員（Email、姓名、電話、狀態、是否驗證、註冊與最後登入時間）。不含密碼雜湊；沒有任何改密碼的工具。會員資料屬個資，只轉達給網站主。需要 members:read。",
      inputSchema: { site, limit: z.number().int().optional().describe("預設 20，最多 100"), offset: z.number().int().optional(), q: z.string().optional().describe("Email 關鍵字") },
      annotations: RO,
    },
    wrap(async (a) => members.listMembers(ctx, a)),
  );

  server.registerTool(
    "get_member",
    {
      description: "取得單一會員資料（用 memberId 或 email），含訂單數。不含密碼雜湊。需要 members:read。",
      inputSchema: { site, memberId: z.string().optional(), email: z.string().optional() },
      annotations: RO,
    },
    wrap(async (a) => members.getMember(ctx, a)),
  );

  server.registerTool(
    "disable_member",
    {
      description: "停用會員：之後無法登入，現有登入全部失效。必須先讓使用者確認並帶 confirm: true。需要 members:write。",
      inputSchema: { site, memberId: z.string(), confirm: z.boolean().optional().describe("使用者確認後才設 true") },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => members.setMemberStatus(ctx, { ...a, status: "disabled" })),
  );

  /* ------------------------------------------------------------ 商品（shop 模組） */

  const variantSchema = z.object({
    options: z.record(z.string(), z.string()).describe("規格選項，例如 {\"尺寸\":\"M\",\"顏色\":\"黑\"}"),
    price: z.number().int().optional().describe("此規格價格（省略則沿用商品價格）"),
    sku: z.string().optional(),
    stock: z.number().int().optional().describe("庫存；update_product 時沒帶＝不動既有規格的庫存"),
    expectedStock: z.number().int().optional().describe("update_product 改既有規格的 stock 時必填：你讀到的目前庫存"),
  });

  server.registerTool(
    "create_product",
    {
      description:
        "新增商品（需 shop 模組）。價格為新台幣整數。status 預設 draft（不公開）；設 published 會立即上架，另需 publish scope 並帶 confirm: true（使用者確認後）。descriptionMd 為 Markdown。trackInventory=true 時下單會原子扣庫存、售完不能下單。需要 commerce:write。",
      inputSchema: {
        site,
        slug: z.string().describe("商品網址代號，小寫英數與連字號，前台網址 /shop/<slug>"),
        name: z.string(),
        price: z.number().int().describe("售價（NT$ 整數）"),
        compareAtPrice: z.number().int().optional().describe("原價（劃線價）"),
        descriptionMd: z.string().optional(),
        images: z.array(z.string()).optional().describe("圖片 https 網址，第一張為主圖"),
        sku: z.string().optional(),
        trackInventory: z.boolean().optional(),
        stock: z.number().int().optional(),
        sort: z.number().int().optional().describe("排序，小的在前"),
        variants: z.array(variantSchema).optional().describe("規格（有規格時客人必須選一個，庫存以規格計）"),
        status: z.enum(["draft", "published"]).optional(),
        confirm: z.boolean().optional().describe("status 為 published 時必填 true"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => shop.createProduct(ctx, a)),
  );

  server.registerTool(
    "update_product",
    {
      description:
        "修改商品（productId 或 slug 指定），只傳要改的欄位；variants 若有給則整份取代規格清單（依 options 比對既有規格；規格沒帶 stock 就不動它的庫存，要改既有規格的 stock 必須同時帶該規格的 expectedStock）。改商品層 stock 必須帶 expectedStock。草稿商品只需 commerce:write；已上架商品的任何修改、上架、下架都會立即影響線上，需要 publish scope 並帶 confirm: true。",
      inputSchema: {
        site,
        productId: z.string().optional(),
        slug: z.string().optional().describe("目前的 slug（與 productId 二擇一）"),
        patch: z
          .object({
            slug: z.string().optional(),
            name: z.string().optional(),
            price: z.number().int().optional(),
            compareAtPrice: z.number().int().nullable().optional(),
            descriptionMd: z.string().optional(),
            images: z.array(z.string()).optional(),
            sku: z.string().optional(),
            trackInventory: z.boolean().optional(),
            stock: z.number().int().optional(),
            sort: z.number().int().optional(),
            variants: z.array(variantSchema).optional(),
            status: z.enum(["draft", "published"]).optional(),
          })
          .describe("要修改的欄位"),
        confirm: z.boolean().optional().describe("影響已上架商品時必填 true"),
        expectedStock: z.number().int().optional().describe("改 patch.stock 時「必填」你讀到的目前庫存：期間若有訂單扣庫存就拒絕（避免蓋掉）"),
      },
      annotations: WRITE,
    },
    wrap(async (a) => shop.updateProduct(ctx, a)),
  );

  server.registerTool(
    "list_products",
    {
      description: "列出商品（id、slug、名稱、狀態、價格、庫存、規格）。需要 site:read。",
      inputSchema: { site, status: z.enum(["draft", "published"]).optional(), limit: z.number().int().optional(), offset: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => shop.listProducts(ctx, a)),
  );

  /* ------------------------------------------------------------ 訂單 */

  const orderRef = {
    orderId: z.string().optional(),
    orderNo: z.string().optional().describe("訂單編號，例如 LIN-20261018-0001（與 orderId 二擇一）"),
  };

  server.registerTool(
    "list_orders",
    {
      description: "列出訂單（最新在前）：編號、狀態（pending_payment 待付款／paid 已付款／fulfilled 已出貨／cancelled 已取消）、付款方式、金額、訂購人。逾期未付的訂單會在讀取時自動取消並回補庫存。需要 orders:read。",
      inputSchema: { site, status: z.enum(["pending_payment", "paid", "fulfilled", "cancelled"]).optional(), limit: z.number().int().optional(), offset: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => orders.listOrders(ctx, a)),
  );

  server.registerTool(
    "get_order",
    {
      description: "訂單明細：品項、金額、訂購人與收件資料（個資，只轉達給網站主）、付款紀錄狀態、下一步可做的動作（allowedNext）。需要 orders:read。",
      inputSchema: { site, ...orderRef },
      annotations: RO,
    },
    wrap(async (a) => orders.getOrder(ctx, a)),
  );

  server.registerTool(
    "mark_order_paid",
    {
      description: "線下匯款訂單「標記已收款」（待付款 → 已付款），會寄付款成功通知。只限線下匯款訂單（PChomePay 訂單由金流通知自動更新）。必須先讓使用者確認款項已入帳，再帶 confirm: true。需要 orders:write。",
      inputSchema: { site, ...orderRef, confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => orders.markOrderPaid(ctx, a)),
  );

  server.registerTool(
    "fulfill_order",
    {
      description: "已付款訂單標記為已出貨（可帶物流單號），會通知客人。必須帶 confirm: true。需要 orders:write。",
      inputSchema: { site, ...orderRef, trackingNumber: z.string().optional(), shippingMethod: z.string().optional(), confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => orders.fulfillOrder(ctx, a)),
  );

  server.registerTool(
    "cancel_order",
    {
      description:
        "取消訂單（待付款或已付款），會回補庫存且無法復原。🔴 已付款訂單取消「不會自動退款」：PChomePay 訂單需到 PChomePay 商家後台人工退款，線下匯款需自行退款——回傳的 note 會說明。必須帶 confirm: true。需要 orders:write。",
      inputSchema: { site, ...orderRef, reason: z.string().optional(), confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => orders.cancelOrder(ctx, a)),
  );

  server.registerTool(
    "get_payment_setup_status",
    {
      description:
        "查金流設定狀態：PChomePay 憑證是否已設定／驗證、測試或正式環境、shop 模組狀態、是否開放線下匯款。🔴 只能查狀態：金鑰只能由平台擁有者在後台輸入，MCP 沒有設定或讀出金鑰的工具（請勿要求使用者在對話中貼金鑰）。需要 orders:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => orders.getPaymentSetupStatus(ctx, a)),
  );

  /* ------------------------------------------------------------ 電子發票（invoice） */

  server.registerTool(
    "get_invoice_setup_status",
    {
      description:
        "查電子發票設定狀態：invoice 模組狀態、開立時機（manual／auto_on_paid）、憑證是否已設定與驗證、是否已設固定 IP 中繼。🔴 只能查狀態：Amego 憑證只能由平台擁有者在後台輸入，MCP 沒有設定或讀出金鑰的工具。需要 orders:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => invoices.getInvoiceSetupStatus(ctx, a)),
  );

  server.registerTool(
    "list_invoices",
    {
      description: "列出發票（訂單編號、狀態 pending／issuing／issued／failed／voided／allowance、發票號、金額、錯誤）。需要 orders:read。",
      inputSchema: { site, status: z.enum(["pending", "issuing", "issued", "failed", "voided", "allowance"]).optional(), limit: z.number().int().optional(), offset: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => invoices.listInvoices(ctx, a)),
  );

  server.registerTool(
    "get_invoice",
    {
      description: "查某張訂單的發票（狀態、發票號、能否作廢 canVoid、客人選的發票方式）。需要 orders:read。",
      inputSchema: { site, ...orderRef },
      annotations: RO,
    },
    wrap(async (a) => invoices.getInvoice(ctx, a)),
  );

  server.registerTool(
    "issue_invoice",
    {
      description:
        "為已付款訂單開立電子發票（法律文件，開出後只能作廢或折讓）。同一訂單只會有一張（重複呼叫會回傳既有發票）。必須先讓使用者確認，再帶 confirm: true。需要 invoices:write。",
      inputSchema: { site, ...orderRef, confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => invoices.issueInvoice(ctx, a)),
  );

  server.registerTool(
    "retry_invoice",
    {
      description: "重試開立失敗的發票（會先向供應商反查，已開過就認回、不會重開）。必須帶 confirm: true。需要 invoices:write。",
      inputSchema: { site, ...orderRef, confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => invoices.retryInvoice(ctx, a)),
  );

  server.registerTool(
    "void_invoice",
    {
      description:
        "作廢或折讓已開立的發票：同一期（雙月）內 → 作廢；已跨期 → 自動改開折讓單（預設全額，可帶 allowanceAmount 部分折讓）。回傳 action 說明實際做了哪一種。無法復原，必須帶 confirm: true。需要 invoices:write。",
      inputSchema: { site, ...orderRef, reason: z.string().optional().describe("原因（最多 20 字）"), allowanceAmount: z.number().int().optional().describe("跨期折讓金額（NT$ 含稅），省略＝全額"), confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => invoices.voidInvoice(ctx, a)),
  );

  /* ------------------------------------------------------------ 物流（shipping） */

  server.registerTool(
    "get_shipping_setup_status",
    {
      description:
        "查物流設定：已發布的運送方式（id、類型 cvs／home／pickup／manual、運費、滿額免運）、綠界帳號是否設定、測試或正式環境。🔴 綠界憑證只能由平台擁有者在後台輸入，MCP 無法設定或讀出。運送方式用 configure_module shipping { methods, sender } 設定（進草稿，發布後生效）。需要 orders:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => shipping.getShippingSetupStatus(ctx, a)),
  );

  server.registerTool(
    "create_shipment",
    {
      description:
        "為已付款訂單建立出貨單：訂單選的是綠界超商／宅配 → 建立綠界物流單（會產生真實寄件與運費；測試環境帳號不會），訂單在物流回報已寄出後自動轉「已出貨」；手動出貨／自取 → 記錄 trackingNumber 並直接轉「已出貨」。必須先讓使用者確認，再帶 confirm: true。需要 shipping:write。",
      inputSchema: { site, ...orderRef, trackingNumber: z.string().optional().describe("手動出貨的物流追蹤號（綠界物流免填）"), confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    wrap(async (a) => shipping.createShipment(ctx, a)),
  );

  server.registerTool(
    "get_shipment",
    {
      description: "查某張訂單的出貨單（方式、門市、物流狀態、追蹤號、最近的物流事件）。需要 orders:read。",
      inputSchema: { site, ...orderRef },
      annotations: RO,
    },
    wrap(async (a) => shipping.getShipment(ctx, a)),
  );

  server.registerTool(
    "list_shipments",
    {
      description: "列出出貨單（狀態 created／in_transit／arrived／delivered／returned／failed／cancelled）。需要 orders:read。",
      inputSchema: { site, status: z.enum(["created", "in_transit", "arrived", "delivered", "returned", "failed", "cancelled"]).optional(), limit: z.number().int().optional(), offset: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => shipping.listShipments(ctx, a)),
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
        expectedDraftVersion: z
          .number()
          .int()
          .optional()
          .describe("建議帶入 preview_changes 回傳的 draftVersion：若預覽後草稿又被改過，發布會被拒，確保上線的就是使用者看過的那份"),
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
