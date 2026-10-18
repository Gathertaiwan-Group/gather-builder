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
- scopes：`platform:sites`、`site:read`、`content:write`、`design:write`、`modules:write`、`publish`、`inquiries:read`、`members:read`、`members:write`、`commerce:write`、`orders:read`、`orders:write`（`lib/scopes.ts`）。既有 token 不會自動拿到新 scope，要重新發行。
- 預覽連結：HMAC-SHA256 簽 `{ tenantId, exp }`，1 小時有效（`lib/preview.ts`）。
- 後台：單一密碼 → HMAC cookie（`lib/adminAuth.ts`），middleware 擋 `/admin` 與 `/api/admin`，頁面與 API 再驗一次；後台 POST 檢查 Origin 防 CSRF。
- token 發行：發出的 scopes 必須是呼叫者 scopes 的子集（`issue_site_token` 超出直接拒絕；`create_site` 取交集，沒有任何網站 scope 就不發）。
- 限流：`builder_rate_limits` ＋ SQL 函式 `builder_rate_hit`（固定時間窗，`insert … on conflict … returning` 原子計數，跨 serverless 實例有效）。用在聯絡表單（每 IP 每小時，預設 5，被擋的不寫入不寄信）、LINE 點擊（每 IP 每 10 分鐘 30）、後台登入（每 IP 每 15 分鐘 10 次嘗試）、會員登入／註冊／忘記密碼（見「會員」）、結帳（每 IP 每小時 20）、計價（每 IP 每 10 分鐘 120）。
- 錯誤：MCP 只回 `ServiceError` 的訊息；其他內部錯誤只記 server log，回客戶端通用訊息＋追查碼。unique 衝突轉成 `conflict`「資料重複」。

## 會員（members 模組）

平台自管帳號，**不用 Supabase Auth**（共用專案還住著其他客戶站）。

- **隔離**：帳號唯一性是 `(tenant_id, email)`，同一個 email 在不同網站是不同帳號、不同密碼。session cookie 名為 `gbm_<tenant id 前 12 碼>`、`Path=/s/<slug>`、HttpOnly、SameSite=Lax、prod 加 Secure，瀏覽器不會把 A 站 cookie 送到 B 站；server 端另外比對 `session.tenant_id === 目前網站`，cookie 被搬到別站也無效。
- **儲存**：密碼 scrypt（N=16384, r=8, p=1，每人 16 bytes salt），格式 `scrypt$N$r$p$salt$hash`（參數在字串裡，日後可升級）。session、驗證信、重設密碼 token 都只存 sha256；token 一次性（條件更新 `used_at is null and expires_at > now`），驗證信 48 小時、重設 1 小時。
- **防枚舉**：忘記密碼的寄信以 `after()` 排到回應之後，並補到固定最短回應時間，回應時間不洩漏帳號是否存在。登入失敗（不存在／密碼錯／停用）一律「Email 或密碼錯誤」，帳號不存在時也跑一次同成本的雜湊；註冊已存在的 email 回同一句話（另寄提醒信給帳號本人）；忘記密碼一律回同一句話。
- **限流**（`builder_rate_hit`）：登入每 IP 10 次／15 分＋每 email 10 次／15 分、註冊每 IP 5 次／小時、忘記密碼每 IP 5 次＋每 email 3 次／小時、重設每 IP 10 次／小時。
- 重設密碼成功 → 撤銷該會員所有 session；停用會員 → 同樣撤銷。登出撤銷該筆 session。
- 公開 POST 在 `app/s/[site]/api/account/*`（必須在 `/s/<slug>` 底下才收得到 cookie），檢查 Origin、303 回頁面帶訊息。
- 寄信走 `lib/mail.ts`（Resend）；**沒設 `RESEND_API_KEY` 時不報錯，把信件內容（含連結）寫進 server log**——只適合本機，正式站要設 Resend。

## 電商（shop 模組）

- **計價**：`priceCart()` 是唯一的計價入口，前端只送 `{productId, variantId, qty}`，價格、運費、總額全部依 DB 重算（多送的 price/total 欄位直接丟掉）。購物車存在瀏覽器 localStorage，結帳頁顯示的金額也是呼叫 `/s/<slug>/api/shop/quote` 由 server 算的。
- **下單**：SQL 函式 `builder_place_order`（單一交易）：逐項 `update … set stock = stock - qty where stock >= qty`（只有 `track_inventory` 的商品扣），任一不足就 raise、整筆回滾；同交易內遞增 `builder_order_counters` 產生 `<前綴>-YYYYMMDD-####`（台北日期）並寫入訂單與明細（明細記錄 `stock_deducted`，回補只補真的扣過的）。
- **狀態機**：`lib/shop/machine.ts` 是唯一的轉換表（待付款→已付款/取消、已付款→出貨/取消，fulfilled／cancelled 為終點）；寫入一律條件式（`where status = from`），併發只有一個成功。
- **取消與逾期**：`builder_cancel_order` 在同一交易內轉 cancelled ＋ 呼叫 `builder_release_order_stock`；回補以 `stock_released_at is null` 條件更新為冪等旗標，重複取消／重複回補不會多補。逾期未付在讀取訂單時 lazy 處理，另有每日 cron `/api/cron/expire-orders`（`CRON_SECRET`，Vercel Hobby 只能每日）；**下單前也會先釋放同商品已逾期的保留**（`releaseExpiredHolds`）。
- **保留時間（2026-10 審查 M1）**：線上刷卡 `onlinePaymentHoldMinutes`（預設 60 分鐘，只給 CARD）；ATM 需店家開 `pchomepayAtm`，保留 `orderExpireHours`（≥ 48h，ATM 繳費期限一定更短）；線下匯款保留 `orderExpireHours`（預設 72）。每品項每單上限 `maxQtyPerItem`（預設 10）；每 IP 每小時下單上限 6。
- **🔴 逾期前回查（H2）**：PChomePay 訂單逾期取消前，先對所有 pending 付款做權威回查：已付 → 走付款流程（不取消）；處理中（P／W*）或失敗（F）→ 才取消；回查失敗或狀態無法辨識 → **這次不取消**、累計 `builder_payments.query_failures`，連續 3 次寄店主警示（`alerted_at` 條件更新，只寄一次）。
- **庫存寫入（M2）**：改商品層 `stock` 必須帶 `expectedStock`（條件更新 `where stock = expected`）；`variants` 是 patch 語意——規格沒帶 `stock` 就不動，要改既有規格的 stock 必須帶該規格的 `expectedStock`。
- **庫存回補對位**：明細記錄 `deducted_from`（product／variant）。`update_product` 帶 variants 時依 options 比對沿用原規格列（id 不變）；被移除的規格才刪除，其未付款訂單取消時不會誤補到商品層。後台／MCP 改庫存可帶 `expectedStock`（後台自動帶），期間被訂單扣過就拒絕，避免把庫存蓋回去。
- **GA**：`/account`、`/orders`、`/checkout` 一律不載入 GA（網址可能含一次性 token 或訂單金鑰）。
- **ATM 期限**：保留時間 < 48h 時不提供 ATM（只刷卡）；否則 ATM 期限 = 保留天數 − 1（上限 5），一定早於訂單逾期。
- **訂單成立信**：線下匯款下單即寄；線上付款要等金流建單成功才寄（建單失敗的訂單會被取消）。
- **訂單頁存取**：`/s/<slug>/orders/<編號>?k=<存取金鑰>`（DB 只存 sha256），或下單會員本人登入後直接看。頁面 `noindex`、`no-referrer`。

## 金流（PChomePay，每個租戶自己的商家帳號）

- **憑證**：`builder_payment_accounts`，secret 以 AES-256-GCM 加密（`lib/secretbox.ts`，金鑰 env `PAYMENT_ENC_KEY` 32 bytes；密文格式 `v1.<kid>.<iv>.<tag>.<ct>`，AAD 綁 tenant_id，複製到別的租戶解不開）。**只能從平台後台「金流設定」表單輸入**（服務層檢查 `actor.kind === "admin"`）；MCP 沒有任何設定或讀出 secret／app_id 的工具，`get_payment_setup_status` 只回狀態與遮罩後的 app_id。按「驗證」用該組憑證打 `/v1/token`（sandbox 憑證打 sandbox 端點）。
- **token 快取**以租戶為鍵（並比對 app_id／環境），過期前 60 秒重換，API 回 401 清快取重換一次。
- **流程**：結帳 → `builder_place_order` → 建 `builder_payments`（`gateway_order_no` 唯一，英數 ≤20）→ `POST /v1/payment` → 303 到 `payment_url`。金流建單失敗 → 取消訂單並回補庫存。金額 < NT$30 不能選線上付款。
- **return_url** = 訂單頁：只顯示狀態、待付款時每 5 秒刷新，**不在 return 上改任何狀態**。
- **notify** `/api/pay/pchomepay/notify/<tenantId>` 安全規則（`handlePchomepayNotify`）：
  1. notify 沒有簽章 → 絕不信 payload，只取 `order_id` 當查詢鍵；付款紀錄的 tenant 必須等於路徑上的 tenant。
  2. 一律用「該租戶自己的憑證」`GET /v1/payment/{order_id}` 回查，且憑證環境必須等於建單時的環境（sandbox／正式，L1）。**權威欄位是 `status`**：`S` 成功（此時 `status_code` 通常為 null）、`F` 失敗、`P` 處理中；`status_code` 是 F*（失敗）／W*（等待）細節碼。依據：Realreal 正式站實作（`apps/api/src/lib/pchomepay.ts`、`routes/webhooks/pchomepay.ts`，2026-07-12 只看 status_code 導致已付訂單卡 pending 的事件）與官方外掛 `includes/OrderStatusCodeEnum.php`（PChomePay 未公開正式查單文件）。無法辨識的狀態 → 不標記、回 500、警示店主。
  3. 權威金額 round 後必須等於付款紀錄與訂單總額，不符不標記（回 success、寫 log）。
  4. 回查失敗或缺金額 → 回 500 讓對方重試；其餘處理完一律回純文字 `success`。
  5. 條件式轉換 `pending_payment → paid`：只有真正轉換成功的那一次寄付款成功信（客人＋店主），重複／併發 notify 冪等。
  6. 訂單已取消（含逾期）卻收到付款 → 不改訂單、付款標 `paid_after_cancel`、寫 error log、寄店主警示（需人工退款），警示只寄一次。
- **線下匯款**：訂單 pending_payment，店主在後台或 MCP `mark_order_paid`（`orders:write`＋confirm）；PChomePay 訂單不能手動標記。
- **🔴 sandbox 憑證（H1）**：sandbox 憑證只在「帶有效預覽簽章」的結帳可用（結帳頁在 `?preview=` 模式會把簽章帶進表單，`handleCheckout` 驗簽後才允許）；已發布網站的一般訪客看不到線上付款。sandbox 付款成功的訂單標記 `builder_orders.payment_sandbox`，店主信寫「請勿出貨」，`fulfill_order` 一律拒絕；後台訂單列表顯示 sandbox 標記；「測試環境」勾選框預設不勾。
- 🔴 規則：正式金鑰不准拿來測試；`scripts/e2e-pchomepay-sandbox.mjs` 只允許 localhost＋sandbox，且不跟隨付款頁。notify 用單元／整合測試模擬（mock 回查結果）。

## 已知風險（第一版刻意不處理）

| 風險 | 現況 | 日後方案 |
|---|---|---|
| 後台 session 無法單獨撤銷 | cookie 是無狀態 HMAC（12 小時），登出只刪自己瀏覽器的 cookie；外洩的 cookie 在到期前都有效。緊急時只能換 `ADMIN_SESSION_SECRET`（全部登出）。 | 改成 DB session 表（`builder_admin_sessions`，cookie 只放隨機 id），可逐筆撤銷；或換成正式身分系統（多使用者＋2FA）。 |
| 前台與後台同源 | 租戶網站 `/s/<slug>` 與 `/admin` 同一個 origin。租戶內容雖然不能放程式碼（Markdown 轉義、URL 白名單、props strict），但若未來區塊出現 XSS，就能直接帶著後台 cookie 呼叫 `/api/admin`。 | 後台移到獨立子網域（例如 `admin.builder.gather.tw`，cookie 不設 Domain），租戶網站走子網域／自有網域；再加 CSP。 |
| 未付款訂單佔庫存 | 訪客下單即扣庫存，保留到逾期（預設 72h）；每 IP 每小時 20 單限流，但多 IP 仍可凍結限量商品。 | 線上付款縮短保留時間、每 email/電話限制同時 pending 單數、提高 cron 頻率。 |
| 更換 PChomePay 憑證後舊單回查失敗 | notify 回查用「目前」的憑證；正式帳號 A→B 更換後，A 帳號的未完成付款回查會失敗（回 500 讓對方重試），可能逾期取消且不會警示。 | payments 記錄建單時的 app_id、或有 pending 線上付款時禁止更換憑證、回查連續失敗寄警示。 |
| 所有租戶同源 | `/s/<slug>` 共用一個 origin：cookie 的 path／名稱隔離只防瀏覽器自動帶 cookie，防不了同源 JS。目前租戶無法放自訂程式碼（只允許 G- 格式 GA、Markdown 已消毒）。 | 開放任何自訂 HTML/script/GTM 之前，必須先改子網域或自有網域隔離。 |
| 登入限流 | 已改為 email＋IP 組合（10 次／15 分）為主、每 IP 30 次；email 單獨超過 100 次／15 分只延遲 1.5 秒不鎖死。分散式大量 IP 仍可慢速猜測。 | 加 CAPTCHA 或裝置指紋。 |
| 會員信件依賴 Resend | 沒設 `RESEND_API_KEY` 時驗證／重設連結只寫 server log（正式站 log 會含一次性連結）。 | 正式站一定要設 Resend；長期改成每個租戶自己的寄件網域。 |
| 已付款訂單取消不會退款 | `cancel_order` 只改狀態與回補庫存，會提示需到 PChomePay 後台人工退款。 | 金流退款 API 串接＋退款狀態欄位。 |
| 逾期取消只靠 lazy＋每日 cron | Hobby cron 只能每日，期間未被讀到的逾期訂單最多佔庫存約一天。 | 升級方案改成每小時，或 Supabase pg_cron。 |
| 會員密碼重設只寄信 | 沒有「登入中改密碼」頁、沒有 2FA。 | 會員中心加改密碼（需舊密碼）＋ email 變更流程。 |
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
