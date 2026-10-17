# 架構

## 總覽

```
            ┌────────── /admin（平台擁有者後台，HMAC cookie）──┐
            │                                                 │
 Browser ───┤                                                 ├──► lib/services/*（唯一的業務邏輯）──► Store ──► Supabase (public.builder_*)
            │                                                 │        權限 scope／租戶隔離／zod 驗證／稽核
 AI agent ──┴────────── /api/mcp（MCP Streamable HTTP，Bearer）┘

 訪客 ──► /s/<slug>/…（前台，讀已發布快照；?preview=<簽章> 讀草稿）
```

## 多租戶

- `builder_tenants` 一列一個網站；所有資料表都帶 `tenant_id`。
- 「這個 request 是哪個租戶」集中在 `lib/tenant-resolve.ts`（目前只認 `/s/<slug>`）。
- 服務層 `resolveTenant(ctx, site)` 強制隔離：租戶 token 只能操作自己的網站（帶別的 slug 直接 `forbidden`）；平台 token／後台必須指定 slug。

## 內容模型：草稿／發布快照／版本

- `builder_site_drafts.content`：可編輯草稿 `{ theme, pages:[{ path, title, seo, sections:[{ id, type, props }] }], nav }`，schema 在 `lib/content.ts`。
- 每次寫入（`mutateDraft`）都會讀草稿 → 修改 → 用 zod 驗證整份結構 → 存回。區塊 props 依模組的 zod schema 驗證；區塊類型所屬模組必須已啟用。
- `publish_site`（必須 `confirm: true`）呼叫 SQL 函式 `builder_publish`：在單一交易中鎖住租戶列、把草稿凍結成下一個版本號（`builder_site_revisions`）、設為 `published_revision_id`。
- `rollback`（同樣需 `confirm: true`）呼叫 `builder_rollback`：把指定版本設為已發布，並覆蓋草稿；不新增版本，下一次發布版本號照樣遞增。
- 前台頁面 `force-dynamic` ＋ Supabase client 強制 `cache: "no-store"`，發布後立即看到新版（不會被 Next Data Cache 卡住）。
- 文章、作品集、詢問屬於「模組資料」，不在快照裡：文章 `status=published` 就上線。模組設定（`configure_module`）也立即生效。

## 一層服務、兩個入口

- `lib/services/*.ts` 是唯一的讀寫邏輯，每個函式第一行宣告所需 scope（`requireScope`），寫入後 `audit()` 寫 `builder_audit_log`。
- MCP（`lib/mcp/tools.ts`）與後台（`app/api/admin/*`）都只是把參數轉給服務函式；後台的身分是 `adminActor()`（擁有全部 scope）。
- 錯誤一律 `ServiceError(code, message)`，MCP 回 `isError` 文字 `[code] message`，後台轉成頁面訊息。
- 單元測試用 `lib/store/memory.ts`（與 SQL 函式同語意）直接測服務層。

## 認證與權限

- MCP：`Authorization: Bearer <token>` → `authenticateBearer()` 比對 `builder_api_tokens.token_hash`（sha256，原文只在建立時顯示一次）、未撤銷 → `Actor { tenantId, scopes }`，更新 `last_used_at`。
- 刻意不做 OAuth 流程、不提供 `/.well-known/oauth-*`、401 不帶 `resource_metadata`（避免客戶端誤走 OAuth discovery）。
- scopes：`platform:sites`、`site:read`、`content:write`、`design:write`、`modules:write`、`publish`、`inquiries:read`（`lib/scopes.ts`）。
- 預覽連結：HMAC-SHA256 簽 `{ tenantId, exp }`，1 小時有效（`lib/preview.ts`）。
- 後台：單一密碼 → HMAC cookie（`lib/adminAuth.ts`），middleware 擋 `/admin` 與 `/api/admin`，頁面與 API 再驗一次；後台 POST 檢查 Origin 防 CSRF。

## 擴充點

| 需求 | 改哪裡 |
|---|---|
| 子網域 `<slug>.builder.gather.tw` | `lib/tenant-resolve.ts` 依 host 解析；middleware 把 host rewrite 到 `/s/<slug>`；`siteBasePath()` 回空字串 |
| 自有網域 | 新表 `builder_tenant_domains(domain, tenant_id, verified_at)`；`resolveSiteSlug` 查表；Vercel Domains API 加網域 |
| OAuth 2.1 | 只換 `authenticateBearer()`：驗 access token → 同一個 `Actor` 形狀；scope 字串不變。屆時才提供 `/.well-known/oauth-protected-resource` |
| 付款開通模組 | `builder_tenant_modules.status` 已有 `pending_setup`；加 `billing_status`／訂閱表，`enableModule` 前檢查付款；manifest 已有 `priceSetup/priceMonthly` |
| 改用獨立 schema | 所有存取都經 `lib/store/supabase.ts`；換 schema 只需 `db.schema("builder")` ＋ migration 搬表（需在 PostgREST 暴露該 schema，屬專案層級設定，需另行協調） |
| 租戶自己的後台 | 服務層已依 Actor 隔離；新增租戶使用者表＋登入後產生租戶 Actor 即可複用 |
| 草稿併發 | 目前最後寫入者勝；可在 `builder_site_drafts` 加 `version` 欄位做樂觀鎖 |
