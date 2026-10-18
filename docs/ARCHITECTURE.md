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
- scopes：`platform:sites`、`site:read`、`content:write`、`design:write`、`modules:write`、`publish`、`inquiries:read`、`members:read`、`members:write`、`commerce:write`、`orders:read`、`orders:write`、`invoices:write`、`shipping:write`、`marketing:write`、`newsletter:read`、`newsletter:write`（`lib/scopes.ts`）。既有 token 不會自動拿到新 scope，要重新發行。
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

## 發票（invoice 模組）

- **供應商介面** `lib/invoice/provider.ts`：`issue`／`void`／`allowance`／`query`／`verify`，結果三態（成功／可重試／永久錯誤）。第一家 `lib/invoice/amego.ts`（官方文件 https://invoice.amego.tw/api_doc/ ：`/json/f0401` 開立、`/json/f0501` 作廢（陣列）、`/json/g0401` 折讓（陣列、未稅＋稅額、AllowanceType 2）、`/json/invoice_query` 反查；`md5(data+time+appKey)`，data 只序列化一次）。另有 `mock`（只限 `is_test` 租戶，e2e 用）。
- **憑證**：`builder_invoice_accounts`（賣方統編＋App Key，secretbox 加密綁租戶），**只能從平台後台輸入**；MCP 只有 `get_invoice_setup_status`。
- **🔴 固定 IP 中繼**：Amego 用 IP 白名單、Vercel 出口 IP 浮動。設 env `AMEGO_RELAY_URL`＋`AMEGO_RELAY_SECRET` 後所有呼叫經中繼（header `x-relay-secret`，只在走中繼時送）；沒設就直連，後台與 `get_invoice_setup_status` 會警示。中繼要放行 `/json/f0401`、`/json/f0501`、`/json/g0401`、`/json/invoice_query`。
- **回應判讀**：每個回應都是 HTTP 200，只看 body 數字 `code`；**沒有數字 code 的回應（中繼自己的 `{"error":…}`、WAF 擋頁、非 JSON）一律視為「暫時失敗可重試」**（小時光曾被誤判成永久失敗卡三天）。`71`＝反查查無（確定沒開過）、`3040171`＝OrderId 重複（2026-10-19 於 Amego 官方測試公司實測）→ 反查認回；`14`（IP 錯誤）可重試；其他非 0 視為資料錯誤，不再自動重試（人工 `retry_invoice` 仍可）。
- **開立（claim-then-act）**：`builder_invoices.order_id` 唯一（同一訂單只會有一列）→ 條件式宣告 `issuing`（attempts＋1，併發只有一個打供應商；卡住 10 分鐘可重新宣告）→ 第 2 次以後**一定先反查**（已開過就認回不重開；反查失敗＝不知道，這次不開）。OrderId＝訂單編號。
- **開立時機**：每租戶設定，預設**手動**（後台或 `issue_invoice confirm:true`）；`auto_on_paid` 時在 `onOrderPaid`（付款真正轉換成功那一次）呼叫，失敗不影響付款。sandbox 付款與未付款訂單不開。每日 cron 重試可重試的失敗。
- **載具**：會員載具（不帶載具欄位＝Amego 會員載具）、手機條碼 `3J0002`（`/^\/[0-9A-Z.+-]{7}$/`）、自然人憑證 `CQ0001`（2 英文＋14 數字）、捐贈 NPOBAN（3–7 碼數字）、三聯式（統編檢查碼：權數 1,2,1,2,1,2,4,1，加權和可被 5 整除、第 7 碼為 7 時加 1 也可）。資料存訂單 `invoice_request`。
- **作廢 vs 折讓**：發票日期與今天（台北）在同一期（雙月）→ 作廢；跨期 → 自動改開折讓（預設全額、可部分）。保守規則：不採用次期申報期限前的寬限。已開立訂單取消時回傳提示 `void_invoice`。
- 訂單 `invoice_status` 同步；會員中心與訂單頁顯示發票號。

## 物流（shipping 模組）

- **運送方式**存在 shipping 模組設定（草稿／發布）。`resolveShipping()` 依**已發布設定**計運費（各方式運費＋滿額免運），試算與下單同一套，前端送的運費一律不採信。沒啟用 shipping 時沿用 shop 的固定運費。
- **綠界憑證**：`builder_shipping_accounts`（MerchantID＋{HashKey, HashIV} 加密、`stage` 旗標、C2C／B2C），只能後台輸入。**stage 帳號只在帶預覽簽章的結帳提供綠界方式**（同 PChomePay sandbox 規則），訂單的 `shipping_choice.stage` 會記下；stage 物流單不會真的寄送。**L-5**：stage 帳號只能為 sandbox 付款或 `shipping_choice.stage` 的訂單建物流單、套用狀態通知，正式訂單一律拒絕。
- **電子地圖選店**：`cvs-start` 建 `builder_cvs_selections`（MerchantTradeNo 20 碼隨機、只存 sha256；另一個瀏覽器秘密存成 binding cookie `gbcvs_<tenant>`、只存 sha256）→ 整頁 POST 到綠界 `/Express/map` → 綠界頁面 POST 回 `/api/ship/ecpay/map/<tenantId>`（**沒有 CheckMacValue**）：驗 MerchantID＝該租戶、子類型相符、暫存未使用未過期才寫門市 → 303 回結帳頁。下單時 `consumeCvsSelection` 要同租戶＋binding 相符＋已選門市＋未使用未過期（原子），失敗歸還。別人的瀏覽器拿不到 binding，綁不到別人的結帳。
- **物流單**：`create_shipment confirm:true`。綠界：先寫 `builder_shipments`（同一訂單只能一張有效出貨單，partial unique index）再打 `/Express/Create`；回應 `1|key=value…`（只解析尾段）、C2C 成功 RtnCode `300`、B2C／宅配 `1`，並驗回應 CheckMacValue；失敗標 `failed`（釋放名額，可重建）。收件人姓名（中文 2–5／英文 4–10、不可混合數字空白符號）與手機在結帳就先擋。訂單維持「已付款」，**以物流狀態為準**：狀態通知回報寄出（2030／3024…）才轉「已出貨」；手動出貨／自取直接轉。綠界物流單存在時 `fulfill_order` 會被拒。
- **狀態通知** `/api/ship/ecpay/notify/<tenantId>`：CheckMacValue 依官方演算法（參數 A→Z 不分大小寫排序、前後加 HashKey／HashIV、.NET URL encode、小寫、MD5、大寫；官方範例向量測試）以**常數時間比較**，不符回 `0|CheckMacValueError`（綠界會重送）；MerchantID、AllPayLogisticsID 也要相符；正確回純文字 `1|OK`。狀態只往前走。
- 官方測試特店（https://developers.ecpay.com.tw/?p=7398）：C2C 2000933、B2C 2000132（官方公開測試值，只用於 stage；見 `lib/shipping/ecpay.ts`）。`scripts/e2e-ecpay-stage.mts` 實測 stage。

## 行銷（coupons／referral／newsletter／ai-chat）

- **折扣碼**：`applyPromotions()` 在 `priceCart()` 之後計折扣（只算商品小計），第一版一單一張。**原子扣用在 `builder_place_order` 同一交易**：`used_count < max_uses` 條件更新＋`builder_coupon_user_counts` upsert（`count < per_user_limit`），任一不足 raise 整筆回滾，併發不超用（真 DB 測 8 搶 3）。取消／逾期由 `builder_cancel_order` 呼叫 `builder_release_coupon`（`released_at is null` 冪等）。每人＝**正規化後的 email**（會員用帳號 email、訪客用結帳 email；小寫、去 +tag、gmail 去點，`lib/email-normalize.ts`），會員與訪客同信箱視為同一人（2026-10 審查 M-3；2026-10 以前以 member id 記的舊次數仍會一併計入）。**免運門檻一律用折扣後的商品金額判斷**（`flatShippingFee`／`resolveShipping` 收 subtotal − discount，試算與下單同一套；M-2）。
- **推薦**：會員推薦碼；分享連結 `/s/<slug>/api/ref/<碼>` 設 HttpOnly cookie，結帳只從 cookie 讀（表單欄位不採信），自己推薦自己（同會員或同 email）忽略。付款成功 hook：首次付款（該人無其他已付款訂單）→ `builder_referrals` unique(tenant, referee_key) 保證只一次 → 發限推薦人本人、單次、有效期的回饋券。**H-1（2026-10 審查）**：referee_key 與自推比對都用正規化 email（alias 開分身無效）；每位推薦人每月上限 `rewardMonthlyLimit`（預設 10，台北月）；被推薦訂單取消 → `revokeReferralByOrder`（revoked_at 條件更新，冪等）＋停用回饋券（已被使用的無法收回，記稽核 `referral.revoke`）。KOL 分潤 `builder_referral_ledger`：service_role 只有 select／insert（只增不改），取消時另記 reverse，unique(order_id, kind) 保證只各一筆。
- **電子報**：雙重確認（確認 token sha256、48h、一次性）；群發 `draft → sending` 條件式只成功一次、`sent` 後拒絕；寄送列 unique(broadcast, subscriber) 只建「已確認」者、寄前再查一次狀態；**每批先原子宣告 queued → sending（`builder_claim_deliveries`，FOR UPDATE SKIP LOCKED），只寄自己宣告到的列，併發接續不重寄；宣告超過 15 分鐘仍未完成＝寄了沒有不知道 → 標 failed、不重寄（M-1）**；每次 50 封、逐封記錄結果、`remaining` 再呼叫接續不重寄。退訂 token＝HMAC(PREVIEW_SECRET, broadcast:subscriber)，DB 存 sha256、一次性；退訂頁與**確認頁**都是 GET 只顯示按鈕、POST 才生效（L-3）。**防轟炸（H-2）**：訂閱端點要同源 Origin＋`Content-Type: application/json`；每個信箱（正規化）同站 24 小時最多 1 封確認信、跨所有租戶 24 小時最多 3 封；未確認期間（連結仍有效）重複訂閱不換 token、不再寄。🔴 `is_test` 租戶群發只寄 `gathertaiwan@gmail.com`；RFC 2606 保留網域（example.com、.test…）一律不實際寄出（`lib/mail.ts`）。
- **AI 客服**：知識＝該租戶已發布頁面文字＋已上架商品＋運費＋設定 `extraKnowledge`；Gemini REST（`gemini-2.5-flash`、`thinkingBudget: 0`，`GEMINI_MODEL` 可覆寫）。限流：每站每 IP 每日、每站每日（`builder_rate_hit`），被擋不呼叫 AI。回覆中不在商品／運費資料內的金額一律遮成「價格請以商品頁為準」——比對 NT$／NT／NTD／TWD／新台幣／＄、數字或中文數字＋元／塊／圓（含「萬」）；折扣語句（打 8 折、85 折、現折、折抵、減 N 元）一律遮（L-2）。對話以 (tenant, session) 存 `builder_ai_chats`；訪客訊息出現 email／電話就寫一筆詢問（每段對話一次）。

## 課程類模組（events／booking／courses）共用規則

- **一律走既有訂單＋付款**：付費報名／預約／課程都是 `builder_orders` 的一張訂單，品項 `builder_order_items.item_kind`（`event_ticket`／`booking`／`course`，`ref_id`＝票種／服務／課程 id，`product_id` 為 null）。建立用 `placeClassOrder()`（`lib/services/class-orders.ts`）→ SQL `builder_place_class_order`：同一交易內編號、寫訂單、優惠券原子扣用（與 `builder_place_order` 同一段，兩邊要一起維護）、**名額預留**（`builder_reserve_for_order` 依 kind 分派）。任一步失敗整筆回滾。
- 付款方式、sandbox 只限預覽簽章（H1）、線上最低金額、保留時間（刷卡 `onlinePaymentHoldMinutes`、線下 `orderExpireHours`，但**不晚於開始時間**；剩不到 10 分鐘不接受付費）、下單信、notify 權威回查、逾期前回查（H2）全部沿用 shop。第一版不提供 ATM。需要啟用 shop（免費項目不需要）。
- **取消／逾期**：`builder_cancel_order`（簽章不變）在同一交易呼叫 `builder_release_order_reservations` 釋放名額（冪等，只動 held／confirmed）。所以店主取消、逾期 lazy 取消、每日 cron、金流建單失敗取消，名額都會回來。
- **付款成功**：只在訂單真正轉成 paid 的那一次（`onOrderPaid`，sandbox 付款不跑）由各模組的 hook 確認報名／預約、開通課程。取消 hook 收到呼叫端的寄信函式（`runCancelHooks(…, deps)`）。
- **簽章連結不存原文**：簽到碼、候補保留連結、預約自助管理連結都是 `HMAC(PREVIEW_SECRET, 用途:id)`，伺服器可重算；簽到碼 DB 只存 sha256。換 `PREVIEW_SECRET` 會讓舊連結與簽到碼失效。
- **個資**：名單／預約／學員列表一律遮罩（`maskContact`）；查看完整資料、匯出 CSV 寫 `builder_pii_access_log`（只增不改：service_role 只有 select／insert）＋稽核。CSV 每格經 `csvCell()`：`= + - @`、Tab、CR 開頭前置單引號、全部加雙引號（防 CSV injection）、加 BOM。
- 時間一律 Asia/Taipei（固定 UTC+8，無夏令時間）。
- **sandbox 付款不佔名額（M3）**：sandbox 付款成功走 `builder_mark_paid_sandbox`（同一交易轉 paid＋`payment_sandbox`＋把報名／預約保留標 cancelled `sandbox_payment`），之後跑取消側 hooks（候補遞補）；課程本來就不開通。
- **防假資料灌爆（M5）**：每個正規化 email 每場次只能一筆有效報名（SQL 鎖場次後檢查 `email_norm`）；免費報名與候補預設要 email 確認（events 設定 `requireEmailConfirm`，預設 true；已登入且 email 已驗證的會員免確認）：免費報名先 held＋`hold_expires_at`（30 分鐘，逾期在下次報名／遞補時由 SQL 標 expired），候補先 `unconfirmed`（30 分鐘）；確認連結 `/s/<slug>/events/confirm?r|w=<id>&t=HMAC`，GET 只顯示按鈕、POST 才確認。免費預約每個 email 每天上限 `freeBookingsPerEmailPerDay`（預設 2，`builder_rate_hit`）。每 IP 每小時 12 次的表單限流照舊。
- **遞補連結不可轉讓（M4）**：認領時聯絡 email（正規化）必須等於候補者的 `email_norm`，候補時有登入會員就必須同一會員；SQL 認領條件另比對 email_norm。
- 報名成功的轉址不帶 email／簽到碼（L6）；未付款預約改期會把訂單付款期限縮到不晚於新時段（L8）；確認信「已付」顯示訂單實付（L7）；遞補略過停用或不在販售期間的票種（L3）；取消場次先標 cancelled 再列報名（L4）；首單判斷 `countPaidOrdersFor` 用 SQL `builder_norm_email`（與 `lib/email-normalize.ts` 同規則，真 DB 比對測試，L5）；CSV 也跳脫全形 ＝＋－＠（L1）。
- `builder_pii_access_log` 只增不改：service_role 的 update／delete／truncate 已收回（M1，真 DB 42501 測試）。

### events（活動報名）

- 活動（draft／published／cancelled）→ 場次（時間、容量、`offline_seats` 手動保留）→ 票種（價格 0＝免費、每單上限、販售期間、配額）。
- **名額沒有計數欄位**：一律由報名列（held＋confirmed）＋有效候補保留＋`offline_seats` 即時加總，`builder_reserve_event` 在交易內 `select … for update` 鎖住場次列再判斷（真 DB 測：8 人搶 1 席只成功 1 筆；付費 6 人搶 1 席只成立 1 張訂單）。記取快樂手 seats_taken 假資料、beunion registered_count 混入線下人數的教訓。
- 免費票：直接 confirmed、寄確認信（簽到碼）。付費票：訂單＋held 保留，付款後 confirmed 並寄確認信；線上活動連結只寄給已確認者。
- **候補**：名額不足才能登記（正規化 email 同場次只能排一次）。`builder_offer_waitlist`：鎖場次 → 過期保留標 lapsed → 嚴格 FIFO 把空位保留給下一位 `waitlistOfferHours`（預設 24h，不超過開場）。保留本身佔名額，同一個空位不會給兩個人，重複呼叫冪等。觸發點：訂單取消／逾期（cancel hook）、登記候補時、每日 cron、名單讀取前的 lazy 釋放。遞補信帶簽章連結 `/events/<slug>?offer=<id>&t=<簽章>`，報名時在同一交易把保留改成 claimed。
- 簽到：後台輸入簽到碼或名單上按鈕（`check_in` confirm）；只有 confirmed 能簽到，條件式只成功一次。第一版不產生 QR 圖（簽到碼 10 碼，可自行轉 QR）。
- 提醒：每日 cron（`/api/cron/expire-orders`，台北 03:17）寄「現在到明天結束」之間開始的場次；`reminder_sent_at` 條件式更新，cron 重跑或併發都只寄一次。
- 取消場次（`cancel_session` confirm）：未付款保留 → 取消訂單；已付款 → 報名取消並標 `refund_required`（不自動退款）；免費／候補 → 取消；全部寄通知。

### booking（時段預約）

- 服務（時長、緩衝、價格、`payment_mode` none 現場付／deposit 訂金／full 全額）→ 服務提供者（第一版自動建「店主」一人；表與 API 都帶 provider_id，可多位）→ 每週時段（台北分鐘數，一天可多段）＋例外日（closed 休假蓋掉當天、open 加開；同日 closed＋open＝只開加開）。
- **可預約時段是純函式** `lib/booking/availability.ts`（`computeAvailability`／`isBookable`）：時段格子＝每段營業時間從開始每 `slotStepMinutes` 一格且服務本身在營業時間內；扣掉 `now + minLeadMinutes` 之前、`maxAdvanceDays` 之後；`[start, start+時長+緩衝)` 不可與既有有效預約的 `[starts_at, block_until)` 重疊（block_until＝結束＋該筆緩衝，所以跨午夜的預約與前一筆的緩衝都會擋到）。單元測試在 TZ=America/Los_Angeles／Asia/Tokyo 都跑過（與伺服器時區無關）。
- **同時段只能一筆（DB 保證）**：`builder_reserve_booking` 在交易內 `for update` 鎖提供者列，再用內建 `tstzrange(...) && tstzrange(...)` 判斷重疊（不需要 btree_gist extension，不動專案層級設定）；另有 `(provider_id, starts_at)` partial unique index 當第二道防線。真 DB 測：6 筆併發搶同時段只成功 1 筆、部分重疊也擋、併發改期到同一空時段只成功 1 筆。
- 建立：先釋放該提供者逾期未付的保留（`expireIfDue`，線上付款單先權威回查）→ 用純函式確認時段可約 → 不收費就直接 confirmed，收訂金／全額走 `placeClassOrder`（金額＝訂金或全額，保留不晚於開始時間），付款成功 hook 才 confirmed。
- 確認信附 `.ics`（`lib/booking/ics.ts`：RFC 5545、UTC 時間、跳脫、75 octets 折行、CRLF；取消時 METHOD:CANCEL 同 UID）；`mail.ts` 的 Mailer 第 4 個參數支援附件（Resend attachments，base64）。另提供 `/s/<slug>/book/ics?b=&t=`（簽章連結）下載。
- 自助管理：`/s/<slug>/book/manage?b=<id>&t=HMAC`（不存原文；頁面 no-referrer、不載入 GA）。開始前 `cancelDeadlineHours`（預設 24）以前可取消／改期；已付款取消 → 標 `refund_required`（不自動退款），未付款保留 → 取消訂單。改期用 `builder_reschedule_booking`（鎖提供者、排除自己判斷重疊），會重置提醒。
- 店主：後台「預約」週曆（7 欄，手機橫向捲動）、查看完整資料（留紀錄）、取消（confirm）。每日 cron 寄「現在到明天結束」的提醒，`reminder_sent_at` 條件式只寄一次。
- 營業時間、例外日、服務上架都會立即改變線上可預約時段 → 需要 `publish` scope ＋ `confirm`（同 publish_site 門檻）。休假不會自動取消既有預約（回傳會提示）。

### courses（線上課程）

- 課程（價格 0＝免費，登入即可加入）→ 單元（影片、Markdown、附件、免費試看、草稿）。**影片網址白名單**（`lib/courses/video.ts`）：只接受 https 的 YouTube（含未公開、shorts、embed，轉成 `youtube-nocookie.com/embed/ID`）與 Vimeo（含未公開 hash），其他網域一律拒絕。
- 購買必須登入會員（存取權綁會員；同一 email 在不同網站是不同會員）。已擁有或已有未逾期的待付款訂單時拒絕再買。品項 `item_kind=course`，沒有名額預留。
- **開通只在付款成功那一次**：`onOrderPaid` 的 hook（`onCourseOrderPaid`）——線下匯款 `mark_order_paid`、PChomePay notify 權威回查已付（條件式轉換只成功一次）。**sandbox 付款不跑 hook → 不開通**。`builder_grant_enrollment`：unique (tenant, course, member)，已開通不動、已撤銷才重新開通（真 DB：併發 6 次 hook、5 次 grant 只有 1 筆真的開通）。
- **撤銷**：訂單取消／逾期（cancel hook）撤銷「由這張訂單開通」的存取權（只動 active，冪等）；手動開通的不受影響。店主 `grant_course`／`revoke_course`（attendees:write＋confirm）。
- **權限在伺服器端**：上課頁只用 `lessonForViewer()` 的結果渲染；未開通且不是試看單元時，回傳物件根本沒有 videoUrl／內容／附件，所以付費影片網址不會出現在 HTML（e2e 以實際 HTML 驗證）。課程介紹頁只列單元標題。上課頁 no-referrer、不載入 GA。
- 進度：`builder_course_progress` (member, lesson) 主鍵，冪等；會員中心「我的課程」顯示完成數。

## 會員經營（loyalty 點數＋等級／stored-value 儲值金）共用規則

- **帳本只增不改**：`builder_points_ledger`、`builder_wallet_ledger`。service_role 只有 select／insert（update／delete／truncate 收回，真 DB 測 42501）。**餘額＝帳本加總**，沒有可改的餘額欄位。唯一寫入入口是 SQL `builder_ledger_post`：每位會員一把交易鎖（`pg_advisory_xact_lock`）、`ref` 冪等鍵（unique(tenant, ref)，例如 `order:<id>:earn`）、寫入前先把已到期的剩餘寫成 `expire`；`strict` 扣帳可用不足就 raise、`capped` 扣到可用為止（不足記 `meta.shortfall`）。
- **到期（FIFO）**：批次＝正數且非退回的分錄（earn／topup／adjust＋，可帶到期日，null＝不到期排最後）；消耗（負數分錄減掉退回）依到期日先後分配；分配後仍有剩且已過期＝待到期，下一次記帳或每日 cron（`builder_ledger_expire`）寫成 expire。退回（reverse／refund 正數）讓消耗變少，點數回到最後被用掉的批次（那批已到期就會再到期）。SQL `builder_ledger_state` 與 TS `lib/loyalty/ledger.ts` 同一套規則（真 DB 比對測試）。已知限制：調短到期天數後，新批次可能比舊批次先到期，消耗會先算到最早到期的批次。
- **下單原子扣用**：`builder_place_order`／`builder_place_class_order`（簽章不變）在同一交易呼叫 `builder_apply_order_credits`：寫回訂單 `tier_discount`／`points_redeemed`／`points_discount`／`wallet_paid`，並以 strict 扣點／扣儲值金——不足整筆回滾（真 DB：可用 300 點、8 張訂單各用 100 點只成立 3 張）。取消／逾期由 `builder_cancel_order` 同交易呼叫 `builder_release_order_credits` 退回（ref 冪等）。
- **計價**（`lib/services/credits.ts`，server 端；前端只送想用多少）：商品（扣折扣碼）→ 等級折扣 % → 點數折抵（上限＝商品金額 × `maxRedeemPercent`，超過自動降到上限；1 點＝`pointValue` 元）→ 加運費 → 儲值金（最多付到剩下全部）。`total`＝要用付款方式收的錢。免運門檻仍用「折扣碼後」的商品金額（等級／點數折抵不影響免運）。
- **🔴 線上付款最低 NT$30**：折抵後剩 1–29 元卻選線上付款 → **拒絕**並說明（少用一點點數／儲值金、全額折抵、或改線下匯款），不會默默改付款方式。剩 0 元且有用點數／儲值金 → 付款方式改為 `credit`（不經金流）、下單後立即條件式轉已付款並跑付款成功流程。
- **發票**：金額＝`total + wallet_paid`（儲值金是預收款，消費時才是銷售）；等級折扣與點數折抵列為折扣。儲值方案訂單不開發票。
- 只在 shop 結帳提供折抵（活動／預約／課程訂單目前不能用點數或儲值金，但付款後一樣會賺點）。

### loyalty（點數＋等級）

- **賺點**：付款成功 hook（只在真正轉成已付款那次；sandbox 不跑）依「商品淨額＝小計 − 折扣碼 − 等級折扣 − 點數折抵」（不含運費）× 等級倍率：`floor(floor(淨額 / earnPerAmount) × 倍率)`，到期日＝付款時 + `pointsExpireDays`（預設 365）。ref `order:<id>:earn` 冪等。儲值方案訂單不賺（儲值金消費時才賺）。
- **取消沖回**：折抵的點數由 SQL 同交易退回；這張訂單賺到的點數以 `capped` 沖回（ref `order:<id>:earn_reverse`）——🔴 若已被用掉導致不足：**扣到 0 為止、不讓餘額變負、不追討**，不足部分記在分錄 `meta.shortfall` 與稽核 `loyalty.reverse_shortfall`。
- **等級**：依 `tierWindowMonths`（預設 12，0＝累計）內已付款的商品淨額（`builder_member_spend`，不含運費、儲值、sandbox）取最高達標等級；`builder_member_tiers` 是快照（超過 1 天自動重算），付款／取消 hook 即時重算，每日 cron 重算全部（降級）。等級影響賺點倍率與等級折扣（商品金額 %）。等級設定在模組設定（`update_tiers`／`configure_module`，草稿→發布）。
- 會員中心「我的點數」：可用點數、即將到期批次、等級與升級門檻、點數紀錄。

### stored-value（儲值金）

- **儲值方案** `builder_topup_plans`：付 `pay_amount`（≥ 30）→ 入帳本金（不到期）＋ `bonus_amount` 贈送額度（`bonus_expire_days` 天後到期，可不設）。上架／改已上架方案需 publish＋confirm。
- **購買**：必須登入會員；`placeClassOrder` 建 `item_kind=topup` 的訂單（不能用折扣碼／點數／儲值金），付款方式、sandbox 只限預覽（H1）、notify 權威回查全部沿用。**付款真正成功那一次**（onOrderPaid hook；sandbox 不跑）才入帳，ref `order:<id>:topup`／`:bonus` 冪等。儲值訂單不開發票、不賺點、不計入等級消費。
- **消費**：結帳選用儲值金（全額或部分），下單交易內 strict 扣款（ref `order:<id>:spend`），取消／逾期同交易退回（refund，ref `:spend_refund`）。FIFO：會到期的贈送額度先用，本金最後。
- **儲值訂單取消**：收回本金＋贈送（`capped`，ref `:topup_reverse`）；🔴 已用掉的部分只收回到 0（不讓餘額變負），不足記 `meta.shortfall`＋稽核 `wallet.reverse_shortfall`，由店家與客人另行處理（例如退款時扣除已用金額）。不會自動退款到信用卡。
- 🔴 **法規**：儲值金屬預收款。正式上線前店家應自行確認是否需依《零售業等禮券定型化契約應記載及不得記載事項》等規定提供履約保證（銀行保證、信託、同業連帶）——平台只提供功能，不提供履約保證。模組說明、MCP 工具說明與後台「會員經營」都有提示。

## 多語（i18n 模組）

- **網址**：預設語言 zh-TW 不加前綴；其他語言 `/s/<slug>/<lang>/…`（en、ja、ko、zh-cn、th、vi、id、fr、de、es）。`middleware.ts` 把 `/s/<slug>/<lang>/<rest>` 改寫成 `/s/<slug>/<rest>` 並設 request header `x-gb-lang`（客戶端自己送的 `x-gb-lang` 一律刪掉；`/s/<slug>/<lang>/api…` 不改寫）。`loadSite` 讀這個 header：語言沒在**目前顯示內容**的 i18n 設定 `languages` 裡（或 i18n 沒開）→ 回 null（404）。所以**所有模組頁面**（商店、文章、活動、課程、會員…）都自動有外文網址；`makeRenderCtx` 的 basePath 帶 `/<lang>`，站內連結（`siteHref`）全部維持在同一語言。頁面路徑不能用語言代碼（`pagePath` 拒絕 /en、/ja/…）。
- **html lang／hreflang**：root layout 依 `x-gb-lang` 設 `<html lang>`；`pageMetadata` 的 canonical 是目前語言網址，`alternates.languages` 列 zh-Hant-TW、各語言與 x-default；og:locale 依語言。頁首有語言切換（同一頁的各語言網址）。
- **頁面翻譯存在草稿／快照**：`content.translations[lang] = { pages: { <path>: { title, seoTitle, seoDescription, sections: { <區塊 id>: { <欄位路徑>: { t, ai } } } } }, nav: { <索引>: { t, ai } } }`，跟著 `publish_site` 上線、`rollback` 一起還原；`preview_changes` 的差異會列出「翻譯有變（含 AI 翻譯）」。
- **可翻譯欄位**（`lib/i18n/translatable.ts`）：區塊 props 的字串葉節點，排除比對鍵與非文字——key 為 id／slug／href／url／src／image／email／phone／code／*Slug／*Id／*Url…，或值是網址、路徑、純數字。渲染時（`SectionList`）只覆蓋「原本存在且為字串、且可翻譯」的位置，**翻譯永遠改不到 slug、價格、id**（記取農經官網比對鍵被翻譯的教訓）。缺翻譯的欄位顯示預設語言。
- **模組資料翻譯** `builder_translations`（post／product／event／course × lang × field，field 只能是 title／name／excerpt／summary／body_md／description_md）：`draft_value` → `publish_translations`（publish＋confirm）才複製到 `published_value`。前台 `localizeRows()` 已發布網站讀 published、預覽讀草稿。
- **AI 翻譯** `translate_content`（MCP、後台「多語」按鈕）：Gemini JSON 模式（`lib/ai/translate.ts`），只送可翻譯欄位、只採用送出去的 key（多回的丟掉）；結果一律進草稿並標 `ai: true`；預設不覆蓋店主手動翻譯（`overwrite: true` 才重翻）。限流（`builder_rate_hit`，DB 原子）：每租戶每日 `aiDailyLimit`（預設 50）＋每分鐘 6 次，被擋不呼叫 AI。沒有 `GEMINI_API_KEY` 時只有 is_test 網站用 mock（`[en] 原文`）供 e2e。
- 已知限制：模組頁面裡的固定按鈕／標籤文字（「加入購物車」「報名」等）第一版仍是中文，只有網站外框（購物車、會員、搜尋、語言、預覽橫幅）有字典；Email 通知仍是中文。

## 站內搜尋（search 模組）

- `/s/<slug>/search?q=`（區塊 `search_box`；頁首有搜尋連結）。關鍵字 1–60 字；每 IP 每 10 分鐘 60 次（`builder_rate_hit`）。
- 頁面：在目前顯示的快照（已發布或預覽草稿）裡比對頁面標題、SEO 描述與所有區塊的可翻譯文字（已套用目前語言的翻譯）。
- 模組資料：SQL `builder_search_content`——`strpos(lower(欄位), lower(關鍵字))` 片語比對（中文可搜；不用 LIKE，`%`／`_` 不會變萬用字元；不新增 extension，不用 pg_trgm）。**只搜該租戶、只搜已發布**（文章另要求發布時間已到）。🔴 課程只比對課程介紹與已發布單元的「標題」，**絕不搜單元內文**（付費內容），摘要也只取課程介紹。外文網址另搜「已發布」的翻譯，命中後再確認主資料已發布才列出。模組沒開的種類不出現。人員名錄、公開文件由各自模組擴充同一個函式。

## 內容型模組（directory／downloads）

- **directory**：`builder_people`；上架、改已上架、下架需 publish＋confirm（同 publish_site 門檻）。聯絡方式（email／電話／網站）預設不公開，`show_contact` 才在前台顯示（前台讀取一律經 `publicPerson()` 遮掉）。已公開人員納入站內搜尋。
- **downloads**：檔案放**私有** bucket `builder-downloads`（`scripts/ensure-buckets.mjs` 以 Storage API 建立；🔴 只准 builder- 開頭的 bucket，程式碼也擋），物件路徑 `<tenant_id>/<document_id>/<淨化檔名>`（DB check 保證在自己的租戶資料夾）。
  - 上傳：後台表單直傳 ≤ 4MB（Vercel body 4.5MB 限制）；更大的檔案（≤ 50MB，bucket 上限）用 `create_document_upload` 取得**簽名上傳網址**直傳 Storage，再 `complete_document_upload`（伺服器確認檔案存在與大小）。檔名淨化（去路徑、控制字元、保留字元；顯示名保留中文；儲存 key 為 ASCII），副檔名白名單（pdf、Office、odt／ods、csv、txt、zip、jpg／png／webp、mp3／mp4），不接受 html／svg／js／exe。
  - 下載：前台連結一律是 `/s/<slug>/downloads/<id>`；伺服器檢查已上架、🔴 限會員的文件要有效會員 session（cookie 屬於該網站、會員未停用），通過才原子計次（`builder_bump_download`）並 302 到 **60 秒**簽名網址（公開文件也一樣，方便統計；`Content-Disposition: attachment`）。未登入 → 導到登入頁。每 IP 每 10 分鐘 120 次。
  - 只有公開且已上架的文件進站內搜尋。

## 證照查詢（certificates 模組）

- `builder_certificates`：證號存兩份——`cert_no` 正規化比對鍵（NFKC 全形轉半形、大寫、去掉空白與分隔符號）、`cert_no_display` 原樣顯示；姓名 `name_norm`（NFKC、去空白）。生日只是**查詢條件**。
- **CSV 匯入**（後台「證照」或 MCP `import_certificates`）：RFC 4180 解析（引號、CRLF、BOM），中英文欄名；必填證號／姓名／生日，日期 YYYY-MM-DD（也接受 / 與 .），驗證日期真實存在、到期不早於發證、證號不重複；🔴 任何欄位以 `= + - @`、Tab、CR（含全形 ＝＋－＠）開頭一律拒絕（防 CSV injection：不讓公式進 DB，日後匯出也不會變成公式）。任何一列有錯整份不匯入；先 dryRun 再 confirm；同證號覆蓋。
- **公開查詢** `/s/<slug>/verify`（區塊 `certificate_lookup`）：前端 POST JSON 到 `/api/s/<slug>/verify`（`guardJsonPost`；生日不進網址）。兩種模式都要完整條件（只給姓名或只給生日不查 DB）；🔴 **不回傳生日**、姓名遮罩（王＊琳）；查無、姓名對生日錯、條件不完整一律回同一句 `LOOKUP_NOT_FOUND`（不洩漏證號或姓名是否存在）；狀態依到期日算（有效／已過期／撤銷／停權）。
- **限流**（`builder_rate_hit`）：每 IP 每 10 分鐘 10 次、每個查詢鍵（正規化證號或姓名）每小時 10 次——換 IP 也擋不了針對同一人的生日暴力猜測。
- **查詢紀錄** `builder_cert_lookups`：只記模式、是否查到、IP 與查詢鍵的雜湊（不存姓名、生日原文）；只增不改（service_role 只有 select／insert，真 DB 42501）。
- scope：`certificates:read`（列表遮罩、不含生日；查詢紀錄）、`certificates:write`（匯入、變更狀態，都需 confirm）。2026-10-19 新增，需重新發行 token。

## 公開 POST 端點

- JSON 端點（電子報訂閱、AI 客服、聯絡表單、LINE 點擊、購物車試算）一律經 `guardJsonPost()`（`lib/public-post.ts`）：同源 Origin、`Content-Type: application/json`（拒絕 text/plain／form 等不需 CORS 預檢的簡單請求）、長度上限（2026-10 審查 H-2／M-5）。
- JSON 端點另有證照查詢（`/api/s/<slug>/verify`）。
- 表單端點（會員、結帳、退訂、確認訂閱、選店）在 `/s/<slug>/api/…`，用 `originOk()`。
- 試算端點（L-4）：每 IP 每 10 分鐘 40 次；折扣碼無效與條件不符回同一句話，細節只在真正下單時回。

## 訂單事件 hook

`lib/services/order-hooks.ts`：模組在載入時以名稱註冊「付款成功」「訂單取消」副作用（referral、events、booking、courses…），`onOrderPaid`／`cancelOrder`／逾期取消呼叫；每個 hook 自己冪等。發票自動開立直接在 `onOrderPaid` 呼叫。
- **失敗補做（2026-10 第四批審查 M2）**：hook 丟錯 → 寫 `builder_hook_failures`（訂單 × hook × 事件 一列，attempts 累加）。每日 cron 與讀取訂單（`get_order`、前台訂單頁）時 `retryOrderHooks` 補做：訂單狀態仍適用才重跑（paid hook 要求已付款／已出貨且非 sandbox；cancel hook 要求已取消），否則標為不再適用；成功標 resolved；連續失敗 3 次寄店主警示一次（`alerted_at` 條件更新），20 次後停止自動補做。hook 內部不可再吞錯（例如報名已失效無法確認要丟出，讓店主收到警示）。
- **系統取消一律跑 hooks（L2）**：金流建單失敗、取消場次、取消預約都走 `cancelOrderWithHooks()`，不再直接 `store.cancelOrder`。

## 已知風險（第一版刻意不處理）

| 風險 | 現況 | 日後方案 |
|---|---|---|
| 後台 session 無法單獨撤銷 | cookie 是無狀態 HMAC（12 小時），登出只刪自己瀏覽器的 cookie；外洩的 cookie 在到期前都有效。緊急時只能換 `ADMIN_SESSION_SECRET`（全部登出）。 | 改成 DB session 表（`builder_admin_sessions`，cookie 只放隨機 id），可逐筆撤銷；或換成正式身分系統（多使用者＋2FA）。 |
| 前台與後台同源 | 租戶網站 `/s/<slug>` 與 `/admin` 同一個 origin。租戶內容雖然不能放程式碼（Markdown 轉義、URL 白名單、props strict），但若未來區塊出現 XSS，就能直接帶著後台 cookie 呼叫 `/api/admin`。 | 後台移到獨立子網域（例如 `admin.builder.gather.tw`，cookie 不設 Domain），租戶網站走子網域／自有網域；再加 CSP。 |
| 未付款訂單佔庫存 | 訪客下單即扣庫存，保留到逾期（預設 72h）；每 IP 每小時 20 單限流，但多 IP 仍可凍結限量商品。 | 線上付款縮短保留時間、每 email/電話限制同時 pending 單數、提高 cron 頻率。 |
| 更換 PChomePay 憑證後舊單回查失敗 | notify 回查用「目前」的憑證；正式帳號 A→B 更換後，A 帳號的未完成付款回查會失敗（回 500 讓對方重試），可能逾期取消且不會警示。 | payments 記錄建單時的 app_id、或有 pending 線上付款時禁止更換憑證、回查連續失敗寄警示。 |
| 所有租戶同源 | `/s/<slug>` 共用一個 origin：cookie 的 path／名稱隔離只防瀏覽器自動帶 cookie，防不了同源 JS。目前租戶無法放自訂程式碼（只允許 G- 格式 GA、Markdown 已消毒）。 | 開放任何自訂 HTML/script/GTM 之前，必須先改子網域或自有網域隔離。 |
| 登入限流 | 已改為 email＋IP 組合（10 次／15 分）為主、每 IP 30 次；email 單獨超過 100 次／15 分只延遲 1.5 秒不鎖死。分散式大量 IP 仍可慢速猜測。 | 加 CAPTCHA 或裝置指紋。 |
| 會員信件依賴 Resend | 正式站已設 `RESEND_API_KEY`／`RESEND_FROM`（2026-10-19，寄件者 `noreply@gathertaiwan.com`）。所有租戶共用同一個寄件網域；沒設時驗證／重設連結只寫 server log。 | 長期改成每個租戶自己的寄件網域。 |
| 已付款訂單取消不會退款 | `cancel_order` 只改狀態與回補庫存，會提示需到 PChomePay 後台人工退款。 | 金流退款 API 串接＋退款狀態欄位。 |
| 逾期取消只靠 lazy＋每日 cron | Hobby cron 只能每日，期間未被讀到的逾期訂單最多佔庫存約一天。 | 升級方案改成每小時，或 Supabase pg_cron。 |
| 會員密碼重設只寄信 | 沒有「登入中改密碼」頁、沒有 2FA。 | 會員中心加改密碼（需舊密碼）＋ email 變更流程。 |
| 發票中繼尚未架設 | gather-builder 還沒有自己的固定 IP 中繼；沒設 `AMEGO_RELAY_URL` 時正式 Amego 帳號會被 IP 白名單擋（code 14，標可重試）。 | 架 Railway／固定 IP 中繼（可參考 alice-store/ops/amego-relay），請 Amego 放行，設兩個 env。 |
| 發票作廢期限採保守規則 | 只有同一期（雙月）可作廢，跨期一律折讓；未採用次期申報前的寬限。 | 依會計需求加設定。 |
| 開立中卡住 | 宣告後行程被砍，列會停在 issuing 10 分鐘，之後重新宣告會先反查。 | 加 cron 主動掃 issuing。 |
| 綠界建單結果不明 | 逾時／連線錯誤／看不懂的回應不再標 failed（M-4）：出貨單維持 created。下次 `create_shipment` 先用原 MerchantTradeNo 打 `QueryLogisticsTradeInfo/V5` 反查：查到 → 認回；明確查無（`0\|找不到訂單`，stage 實測）→ confirm 後用**同一個** MerchantTradeNo 重送；反查失敗 → 不動作。 | 加 cron 主動反查。 |
| 電子地圖選店的跨頁導轉 | 結帳表單用 sessionStorage 暫存填寫內容；隱私模式或關閉分頁會遺失。 | 改用綠界「取得門市清單」API 在頁內選店。 |
| 每人折扣碼次數以正規化 email 區分 | 同一人用不同信箱（不是 +tag／gmail 加點）仍可再用一次；推薦回饋同理（另有每月上限）。 | 限定會員才能用、或加手機驗證。 |
| 電子報分批靠人觸發 | 每次 `send_broadcast` 寄 50 封，名單大時要多次呼叫。 | 背景佇列／cron 接續。 |
| AI 客服知識是即時組的 | 每則訊息都重組知識（商品最多 60 個、全文 30k 字），大型網站會變慢。 | 快取知識或改 RAG。 |
| 課程類退款 | 取消已付款的報名／預約／課程只標待退款或撤銷存取權，不會自動退款。 | 金流退款 API。 |
| 課程類不支援 ATM | 活動票／預約／課程只提供線下匯款與線上刷卡（保留時間不晚於開始時間，ATM 期限難以保證）。 | 依開始時間動態計算 ATM 期限。 |
| sandbox 付款的報名／預約停在 held | sandbox 付款不跑付款 hook，名額會一直保留到店主取消該訂單（只發生在帶預覽簽章的測試）。 | 後台一鍵清除測試訂單。 |
| 簽到沒有 QR 圖 | 簽到碼 10 碼（確認信、會員中心），後台輸入；沒有內建 QR 產生。 | 加 QR 產生器（不依賴外部服務）。 |
| 每日 cron 才遞補／提醒 | Hobby cron 只能每日：候補保留過期後最晚約一天才換下一位（另有讀取時 lazy 處理）；提醒是「明天的活動／預約」。 | 升級每小時 cron 或 pg_cron。 |
| 預約一個提供者 | 第一版前台自動用第一位啟用的提供者（資料結構與 API 都支援多位）。 | 前台選人、每位各自的時段。 |
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
