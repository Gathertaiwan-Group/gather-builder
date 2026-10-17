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
- 每次寫入（`mutateDraft`）都會讀草稿 → 修改 → 用 zod 驗證整份結構 → 以**樂觀鎖**存回（`builder_site_drafts.version`，條件更新 `where version = 讀到的版本`）。衝突時重讀重套一次，再衝突回 `conflict`，不會默默蓋掉別人的修改。區塊 props 依模組的 zod schema 驗證；區塊類型所屬模組必須已啟用。
- `publish_site`（必須 `confirm: true`）先讀草稿（含 version）做驗證與 diff，再呼叫 SQL 函式 `builder_publish(…, expected_draft_version)`：在單一交易中鎖住租戶與草稿列，**版本不符就拒絕**，否則把該版草稿凍結成下一個版本號並設為 `published_revision_id`。所以「驗證過的」與「凍結的」必定是同一份。`preview_changes` 會回 `draftVersion`，agent 帶 `expectedDraftVersion` 發布即可保證上線的就是使用者預覽過的那份。
- `rollback`（同樣需 `confirm: true`）呼叫 `builder_rollback`：把指定版本設為已發布，並覆蓋草稿（草稿 version +1，還原前讀到的舊草稿無法再寫回）；不新增版本，下一次發布版本號照樣遞增。
- 前台頁面 `force-dynamic` ＋ Supabase client 強制 `cache: "no-store"`，發布後立即看到新版（不會被 Next Data Cache 卡住）。
- **模組設定進草稿**：`configure_module`（與 `enable_module` 帶的 config）寫進草稿的 `moduleSettings`，發布後才對外生效；前台與聯絡表單的通知信箱一律讀**已發布快照**的設定。模組的啟用／停用狀態（`builder_tenant_modules.status`）仍是即時的。
- **文章與作品**屬於模組資料、不在快照裡（status=published 就公開）。因此任何會改變線上內容的寫入——新建為 published、修改已公開的項目、上架或下架——都要求 `publish` scope ＋ `confirm: true`，與 `publish_site` 同一道門檻；只有 `content:write` 時只能操作草稿狀態的項目。作品預設 draft。

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
- token 發行：發出的 scopes 必須是呼叫者 scopes 的子集（`issue_site_token` 超出直接拒絕；`create_site` 取交集，沒有任何網站 scope 就不發）。
- 限流：`builder_rate_limits` ＋ SQL 函式 `builder_rate_hit`（固定時間窗，`insert … on conflict … returning` 原子計數，跨 serverless 實例有效）。用在聯絡表單（每 IP 每小時，預設 5，被擋的不寫入不寄信）、LINE 點擊（每 IP 每 10 分鐘 30）、後台登入（每 IP 每 15 分鐘 10 次嘗試）。
- 錯誤：MCP 只回 `ServiceError` 的訊息；其他內部錯誤只記 server log，回客戶端通用訊息＋追查碼。unique 衝突轉成 `conflict`「資料重複」。

## 已知風險（第一版刻意不處理）

| 風險 | 現況 | 日後方案 |
|---|---|---|
| 後台 session 無法單獨撤銷 | cookie 是無狀態 HMAC（12 小時），登出只刪自己瀏覽器的 cookie；外洩的 cookie 在到期前都有效。緊急時只能換 `ADMIN_SESSION_SECRET`（全部登出）。 | 改成 DB session 表（`builder_admin_sessions`，cookie 只放隨機 id），可逐筆撤銷；或換成正式身分系統（多使用者＋2FA）。 |
| 前台與後台同源 | 租戶網站 `/s/<slug>` 與 `/admin` 同一個 origin。租戶內容雖然不能放程式碼（Markdown 轉義、URL 白名單、props strict），但若未來區塊出現 XSS，就能直接帶著後台 cookie 呼叫 `/api/admin`。 | 後台移到獨立子網域（例如 `admin.builder.gather.tw`，cookie 不設 Domain），租戶網站走子網域／自有網域；再加 CSP。 |
| 模組啟用／停用即時生效 | 停用模組會讓已發布網站上該模組的區塊立即消失（`disable_module` 已拒絕草稿仍在使用的情況）。 | 把模組啟用狀態也納入快照。 |

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
