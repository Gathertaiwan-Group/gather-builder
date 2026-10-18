import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceContext } from "../services/context";
import * as loyalty from "../services/loyalty";
import * as wallet from "../services/wallet";
import * as i18n from "../services/i18n";
import * as directory from "../services/directory";
import * as downloads from "../services/downloads";
import * as certificates from "../services/certificates";
import * as reviews from "../services/reviews";
import * as announcements from "../services/announcements";
import { getFileStorage } from "../storage/files";

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

  /* ------------------------------------------------------------ 多語（i18n） */

  const lang = z.string().describe("語言代碼：en、ja、ko、zh-cn、th、vi、id、fr、de、es（要先 configure_module i18n { languages: [...] } 開啟）");
  const target = z
    .object({
      type: z.enum(["page", "nav", "post", "product", "event", "course"]),
      path: z.string().optional().describe("type=page 時的頁面路徑，例如 /about"),
      id: z.string().optional().describe("type=post／product／event／course 時的 id（或給 slug）"),
      slug: z.string().optional(),
    })
    .describe("要翻譯的對象：一個頁面（含頁面標題、SEO、所有區塊的文字欄位）、導覽列、或一筆文章／商品／活動／課程");

  server.registerTool(
    "translate_content",
    {
      description:
        "用 AI（Gemini）把一個頁面／導覽／文章／商品／活動／課程翻成指定語言。只翻文字欄位（slug、價格、網址、id 等比對鍵不送、不改）；結果一律進**草稿**並標記「AI 翻譯」，店主可用 set_translation 修改。頁面與導覽要 preview_changes → publish_site 才上線；模組資料要 publish_translations（confirm）。預設不覆蓋手動翻譯（overwrite: true 才重翻）。每租戶每日上限（i18n 設定 aiDailyLimit，預設 50 次）＋每分鐘 6 次。需要 content:write。",
      inputSchema: { site, lang, target, overwrite: z.boolean().optional() },
      annotations: WRITE,
    },
    wrap(async (a) => i18n.translateContent(ctx, { ...a, target: cleanTarget(a.target) })),
  );

  server.registerTool(
    "set_translation",
    {
      description:
        "手動翻譯或修改 AI 翻譯（進草稿，標記為人工）。fields 的 key：頁面用 title、seoTitle、seoDescription、s.<區塊 id>.<欄位路徑>（例如 s.s_abc123.title、s.s_abc123.items.0.body，可從 list_translations／translate_content 的結果看到）；導覽用 nav.<索引>；文章 title／excerpt／body_md，商品 name／description_md，活動與課程 title／summary／body_md。值為 null＝刪除該欄翻譯（顯示中文）。需要 content:write。",
      inputSchema: { site, lang, target, fields: z.record(z.string(), z.string().nullable()) },
      annotations: WRITE,
    },
    wrap(async (a) => i18n.setTranslation(ctx, { ...a, target: cleanTarget(a.target) })),
  );

  server.registerTool(
    "list_translations",
    {
      description: "翻譯進度：每個語言 × 每頁（可翻譯欄位數、已翻譯、AI 翻譯數）、模組資料的草稿／已發布筆數。需要 site:read。",
      inputSchema: { site, lang: z.string().optional() },
      annotations: RO,
    },
    wrap(async (a) => i18n.listTranslationStatus(ctx, a)),
  );

  server.registerTool(
    "publish_translations",
    {
      description: "把文章／商品／活動／課程的翻譯草稿上線（可限定語言或某一筆）。頁面與導覽的翻譯跟著 publish_site。**必須** confirm: true。需要 publish。",
      inputSchema: { site, lang: z.string().optional(), target: target.optional(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => i18n.publishTranslations(ctx, { ...a, target: a.target ? cleanTarget(a.target) : undefined })),
  );

  /* ------------------------------------------------------------ 人員名錄（directory） */

  const personFields = {
    slug: z.string().describe("網址代稱（小寫英數與連字號），個人頁 /people/<slug>"),
    name: z.string(),
    title: z.string().optional().describe("職稱，例如「理事長」「主治醫師」"),
    category: z.string().optional().describe("分類（篩選用），例如「理監事」「講師」"),
    photoUrl: z.string().optional().describe("照片 https:// 網址"),
    bioMd: z.string().optional().describe("簡介 Markdown"),
    email: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    showContact: z.boolean().optional().describe("true 才在前台顯示 email／電話／網站（預設不公開）"),
    status: z.enum(["draft", "published"]).optional().describe("預設 draft；published 需要 publish scope＋confirm"),
    sort: z.number().int().optional(),
  };

  server.registerTool(
    "create_person",
    {
      description: "新增人員名錄（成員／師資／理監事）。預設草稿；直接上架需 publish＋confirm。聯絡方式預設不公開。需要 content:write。",
      inputSchema: { site, ...personFields, confirm },
      annotations: WRITE,
    },
    wrap(async (a) => directory.createPerson(ctx, a)),
  );

  server.registerTool(
    "update_person",
    {
      description: "修改人員（patch）。已上架或要上架／下架需 publish＋confirm。需要 content:write。",
      inputSchema: { site, personId: z.string().optional(), slug: z.string().optional().describe("用 slug 找人"), patch: z.object(personFields).partial(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => directory.updatePerson(ctx, a)),
  );

  server.registerTool(
    "list_people",
    {
      description: "人員名錄（含草稿）、分類清單。需要 site:read。",
      inputSchema: { site, status: z.enum(["draft", "published"]).optional(), category: z.string().optional() },
      annotations: RO,
    },
    wrap(async (a) => directory.listPeople(ctx, a)),
  );

  /* ------------------------------------------------------------ 文件下載（downloads） */

  const docMeta = {
    title: z.string(),
    category: z.string().optional(),
    description: z.string().optional(),
    visibility: z.enum(["public", "members"]).optional().describe("public 公開（預設）／members 限會員（伺服器檢查登入）"),
    sort: z.number().int().optional(),
  };

  server.registerTool(
    "create_document_upload",
    {
      description:
        "新增一份文件並取得「簽名上傳網址」（檔案直傳私有 Storage，最大 50MB，不經 Vercel）。拿到 uploadUrl 後用 PUT 上傳檔案（Content-Type 用回傳的值），再呼叫 complete_document_upload。檔名會淨化、副檔名限白名單（pdf、Office、圖片、zip、mp3／mp4…）。需要 content:write。",
      inputSchema: { site, fileName: z.string().describe("原始檔名（含副檔名）"), sizeBytes: z.number().int().optional(), ...docMeta },
      annotations: WRITE,
    },
    wrap(async (a) => downloads.createDocumentUpload(ctx, a, getFileStorage())),
  );

  server.registerTool(
    "complete_document_upload",
    {
      description: "確認文件檔案已上傳（伺服器檢查檔案存在與大小）。publish: true 直接上架（需 publish＋confirm），否則為草稿。需要 content:write。",
      inputSchema: { site, documentId: z.string(), publish: z.boolean().optional(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => downloads.completeDocumentUpload(ctx, a, getFileStorage())),
  );

  server.registerTool(
    "update_document",
    {
      description: "修改文件（標題、分類、說明、公開／限會員、上架 status: published／下架 draft）。已上架或要上架需 publish＋confirm。需要 content:write。",
      inputSchema: { site, documentId: z.string(), patch: z.object({ ...docMeta, title: z.string().optional(), status: z.enum(["draft", "published"]).optional() }), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => downloads.updateDocument(ctx, a)),
  );

  server.registerTool(
    "list_documents",
    {
      description: "文件列表（含草稿、上傳中）與下載次數。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => downloads.listDocuments(ctx, a)),
  );

  /* ------------------------------------------------------------ 證照查詢（certificates） */

  server.registerTool(
    "import_certificates",
    {
      description:
        "匯入證照 CSV（第一列標題：證號,姓名,生日,類別,發證日,到期日,狀態；英文 cert_no,name,birth_date,category,issued_on,expires_on,status 也可）。日期 YYYY-MM-DD；欄位以 = + - @ 開頭一律拒絕（防 CSV injection）；任何一列有錯整份不匯入。先 dryRun: true 驗證，使用者確認後 confirm: true 寫入（同證號覆蓋）。需要 certificates:write。",
      inputSchema: { site, csv: z.string().describe("CSV 內容（UTF-8）"), dryRun: z.boolean().optional(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => certificates.importCertificates(ctx, a)),
  );

  server.registerTool(
    "list_certificates",
    {
      description: "證照列表（姓名遮罩、不含生日；狀態依到期日計算）。可用 certNo 查單筆（容錯：全形、大小寫、空白、分隔符號）。需要 certificates:read。",
      inputSchema: { site, certNo: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => certificates.listCertificates(ctx, a)),
  );

  server.registerTool(
    "set_certificate_status",
    {
      description: "變更證照狀態：valid 有效／revoked 撤銷／suspended 停權（立即反映在公開查詢）。**必須** confirm: true。需要 certificates:write。",
      inputSchema: { site, certNo: z.string(), status: z.enum(["valid", "revoked", "suspended"]), note: z.string().optional(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => certificates.setCertificateStatus(ctx, a)),
  );

  server.registerTool(
    "list_certificate_lookups",
    {
      description: "公開查詢紀錄（時間、查詢方式、是否查到；不含查詢內容）。需要 certificates:read。",
      inputSchema: { site, limit: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => certificates.listCertificateLookups(ctx, a)),
  );

  /* ------------------------------------------------------------ 商品評價（reviews） */

  server.registerTool(
    "list_reviews",
    {
      description: "商品評價（評價者姓名遮罩）。status：pending 待審核（未公開）／published／hidden。需要 site:read。",
      inputSchema: { site, status: z.enum(["pending", "published", "hidden"]).optional(), productId: z.string().optional(), limit: z.number().int().optional(), offset: z.number().int().optional() },
      annotations: RO,
    },
    wrap(async (a) => reviews.listReviews(ctx, a)),
  );

  server.registerTool(
    "moderate_review",
    {
      description: "審核評價：publish 公開（顯示在商品頁、計入平均分）／hide 隱藏。**必須** confirm: true。需要 reviews:write。",
      inputSchema: { site, reviewId: z.string(), action: z.enum(["publish", "hide"]), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => reviews.moderateReview(ctx, a)),
  );

  server.registerTool(
    "reply_review",
    {
      description: "店家回覆評價（純文字，1000 字內；空字串＝刪除回覆）。評價已公開時立即顯示。**必須** confirm: true。需要 reviews:write。",
      inputSchema: { site, reviewId: z.string(), reply: z.string(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => reviews.replyReview(ctx, a)),
  );

  /* ------------------------------------------------------------ 公告（announcements） */

  const annFields = {
    title: z.string(),
    bodyMd: z.string().optional().describe("內容 Markdown"),
    pinned: z.boolean().optional(),
    startsAt: z.string().nullable().optional().describe("上架時間（ISO 8601 帶時區；不填＝發布即上架）"),
    endsAt: z.string().nullable().optional().describe("下架時間（不填＝不下架）"),
    audience: z.enum(["all", "members"]).optional().describe("all 所有訪客（預設）／members 僅登入會員"),
    requireAck: z.boolean().optional().describe("必讀確認：會員登入後要按確認，記錄確認時間（只增不改）"),
    status: z.enum(["draft", "published"]).optional().describe("預設 draft；published 需要 publish scope＋confirm"),
  };

  server.registerTool(
    "create_announcement",
    {
      description: "新增公告（置頂、上下架時間、對象、必讀確認）。預設草稿；直接發布需 publish＋confirm。需要 content:write。",
      inputSchema: { site, ...annFields, confirm },
      annotations: WRITE,
    },
    wrap(async (a) => announcements.createAnnouncement(ctx, a)),
  );

  server.registerTool(
    "update_announcement",
    {
      description: "修改公告（patch）。已發布或要發布／下架需 publish＋confirm。需要 content:write。",
      inputSchema: { site, announcementId: z.string(), patch: z.object(annFields).partial(), confirm },
      annotations: WRITE,
    },
    wrap(async (a) => announcements.updateAnnouncement(ctx, a)),
  );

  server.registerTool(
    "list_announcements",
    {
      description: "公告列表（含草稿、是否上線中、必讀確認人數）。需要 site:read。",
      inputSchema: { site },
      annotations: RO,
    },
    wrap(async (a) => announcements.listAnnouncements(ctx, a)),
  );

  server.registerTool(
    "list_announcement_acks",
    {
      description: "必讀公告的確認名單（會員姓名與 email 遮罩、確認時間；完整資料請到後台）。需要 members:read。",
      inputSchema: { site, announcementId: z.string() },
      annotations: RO,
    },
    wrap(async (a) => announcements.listAnnouncementAcks(ctx, { ...a, reveal: false })),
  );
}

/** MCP 的 target 是寬鬆物件；依 type 只留下該型別需要的欄位（服務層用 strict 驗證） */
function cleanTarget(t: { type: string; path?: string; id?: string; slug?: string }) {
  if (t.type === "page") return { type: t.type, path: t.path };
  if (t.type === "nav") return { type: t.type };
  return { type: t.type, ...(t.id ? { id: t.id } : {}), ...(t.slug ? { slug: t.slug } : {}) };
}
