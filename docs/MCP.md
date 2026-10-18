# MCP 連線與工具

端點：`https://<網域>/api/mcp`（Streamable HTTP、無狀態、JSON 回應）
認證：`Authorization: Bearer <token>`。沒帶或錯誤回 401。**沒有 OAuth 流程**，也不提供 `/.well-known/oauth-*`。

## token 種類

| 種類 | 前綴 | 怎麼拿 | 能做什麼 |
|---|---|---|---|
| 平台 token | `gbp_` | 後台 `/admin/tokens` 發行，或 `scripts/issue-platform-token.mjs` | `create_site`、`issue_site_token`、操作任何網站（工具要帶 `site` slug） |
| 網站 token | `gbt_` | `create_site` 回傳一組；或後台／`issue_site_token` 發行（可限縮 scope） | 只能操作自己的網站（`site` 可省略） |

token 原文只在建立時顯示一次，資料庫只存 sha256。後台可隨時撤銷，撤銷後立即 401。

### scopes

| scope | 用途 |
|---|---|
| `platform:sites` | 建站、為網站發 token（只對平台 token 有效） |
| `site:read` | 讀網站、頁面、區塊類型、版本、文章、作品；`preview_changes` |
| `content:write` | 頁面、區塊、導覽（只進草稿）；草稿狀態的文章與作品 |
| `design:write` | 主題 |
| `modules:write` | 啟用／停用／設定模組 |
| `publish` | `publish_site`、`rollback`；文章／作品的公開、修改已公開項目、下架（都還要 `confirm: true`） |
| `inquiries:read` | 讀聯絡表單詢問（個資） |
| `members:read` | 讀會員列表與資料（個資；不含密碼雜湊） |
| `members:write` | 停用會員（需 `confirm: true`） |
| `commerce:write` | 建立／修改商品（上架、改已上架商品、下架另需 `publish` ＋ `confirm: true`） |
| `orders:read` | 讀訂單（含收件個資）、金流設定狀態 |
| `orders:write` | 標記已收款（線下匯款）、出貨、取消（都需 `confirm: true`） |
| `invoices:write` | 開立、重試、作廢／折讓電子發票（都需 `confirm: true`；讀取用 `orders:read`） |
| `shipping:write` | 建立出貨單（綠界物流單或手動出貨，需 `confirm: true`；讀取用 `orders:read`） |
| `marketing:write` | 建立／修改折扣碼、設定推薦 KOL 分潤比例 |
| `newsletter:read` | 讀電子報訂閱者（個資）與群發紀錄 |
| `newsletter:write` | 電子報草稿、寄測試信、群發（群發需 `confirm: true`） |
| `classes:write` | 活動／場次／票種、預約服務與營業時間、線上課程與單元（上架或改已上架項目另需 `publish` ＋ `confirm: true`）；`cancel_session`（confirm） |
| `attendees:read` | 報名名單、預約、課程學員（個資遮罩） |
| `attendees:write` | 簽到、取消預約、手動開通／撤銷課程（都需 `confirm: true`） |
| `certificates:read` | 證照列表（姓名遮罩、不含生日）與查詢紀錄 |
| `certificates:write` | 匯入證照 CSV、變更證照狀態（都需 `confirm: true`） |
| `reviews:write` | 審核（公開／隱藏）與回覆商品評價（都需 `confirm: true`） |

> 新 scope 是 2026-10 加的：之前發行的 token 沒有這些 scope，需重新發行（`create_site` 發出的 token 取呼叫者 scope 的交集）。
> 第三批（invoices／shipping／marketing／newsletter）的 scope 於 2026-10-19 加入，同樣需要重新發行 token 才拿得到。
> 第四批（classes:write／attendees:read／attendees:write）於 2026-10-19 加入，需要重新發行 token。
> 第六批（certificates:read／certificates:write／reviews:write）於 2026-10-19 加入，需要重新發行 token（平台 token 也是：`scripts/issue-platform-token.mjs`）。

## 在 Claude Code 連線

（Claude Code 2.1.214 實測語法）

```bash
# 平台 token（給 Gather 內部用，可開站）
claude mcp add --transport http gather-builder https://<網域>/api/mcp \
  --header "Authorization: Bearer gbp_xxxxxxxx"

# 某個客戶網站的 token（只能動那個站）
claude mcp add --transport http lin-bakery https://<網域>/api/mcp \
  --header "Authorization: Bearer gbt_xxxxxxxx"

claude mcp list          # 確認狀態 ✓ Connected
```

`--transport http` 不能省（預設是 stdio）。加 `-s user` 可讓所有專案共用。
其他客戶端（Cursor、claude.ai 自訂連接器等）：URL 填 `/api/mcp`，自訂 header 填 `Authorization: Bearer …`；若客戶端只支援 OAuth 則目前無法連（見 ARCHITECTURE 的 OAuth 擴充點）。

## 典型對話流程

1. 「列出有哪些模組」→ `list_modules`
2. 「幫我開一個咖啡店網站，要部落格和聯絡表單」→ `create_site`（平台 token）→ 之後改用回傳的網站 token
3. 「首頁加一個主視覺，標題寫…」→ `list_section_types` → `add_section`
4. 「主色換成墨綠」→ `update_theme`
5. 「發一篇文章」→ `create_post`
6. 「我想看看」→ `preview_changes`（給預覽網址，約 1 小時有效）
7. 「OK 發布」→ `publish_site { confirm: true, expectedDraftVersion: <preview_changes 回的 draftVersion> }`
8. 「改壞了，回到上一版」→ `list_revisions` → `rollback { number, confirm: true }`
9. 「我要開始賣東西」→ `enable_module shop`（members 自動帶入）→ `configure_module shop { offlineTransfer, shippingFee, ownerEmail }` → `create_product`（上架要 confirm）→ `add_section product_grid` → 預覽、發布。線上刷卡要請平台擁有者到後台「金流設定」輸入 PChomePay 金鑰並驗證（`get_payment_setup_status` 可查進度）。
10. 「我要開發票」→ `enable_module invoice` → 請平台擁有者在後台「電子發票」輸入 Amego 憑證並驗證（`get_invoice_setup_status` 查進度）→ 付款後 `issue_invoice { orderNo, confirm: true }`（或 `configure_module invoice { issueMode: "auto_on_paid" }` 改成自動）。
11. 「我要超商取貨」→ `enable_module shipping { methods:[{id:"seven",type:"cvs",provider:"ecpay",subType:"UNIMARTC2C",label:"7-11 取貨",fee:60}], sender:{...} }` → 平台擁有者在後台「物流」輸入綠界憑證 → 發布 → 付款後 `create_shipment { orderNo, confirm: true }`。
12. 「來辦個活動」→ `enable_module coupons` → `create_coupon { code:"FALL15", kind:"percent", value:15, maxDiscount:200 }`；電子報 `create_broadcast` → `send_test_broadcast` → 使用者確認 → `send_broadcast { confirm: true }`。
13. 「我要開陶藝工作坊，12/7 下午一場 8 人，一人 1200」→ `enable_module events`（付費要 shop）→ `create_event` → `create_session { capacity: 8 }` → `create_ticket_type { price: 1200 }` → `update_event { patch:{status:"published"}, confirm:true }` → `add_section events_list` → 發布。報名後 `list_registrations`、當天 `check_in`。
14. 「我要開放一對一諮詢，60 分鐘 1500、收 500 訂金，平日 10–18 點」→ `enable_module booking`（訂金要 shop）→ `create_service { durationMin:60, price:1500, paymentMode:"deposit", depositAmount:500, status:"published", confirm:true }` → `set_weekly_hours { hours:[{weekday:1,start:"10:00",end:"18:00"}…], confirm:true }` → `add_section booking_widget` → 發布。「下週三休假」→ `add_date_override { date, kind:"closed", confirm:true }`。
15. 「我要賣線上課」→ `enable_module courses`（付費要 shop）→ `create_course { price }` → `add_lesson`（YouTube 未公開連結；第一課 `isPreview: true`）→ `update_course { patch:{status:"published"}, confirm:true }` → `add_section courses_list` → 發布。學員付款（`mark_order_paid` 或 PChomePay）後自動開通；送課給某人 → `grant_course { email, confirm:true }`。
17. 「我要做會員點數」→ `enable_module loyalty`（members、shop 自動帶入）→ `update_tiers { tiers:[{id:"silver",name:"銀卡",minSpend:3000,multiplier:1.5,discountPercent:5}] }` → `add_section loyalty_tiers` → 發布。客訴補點 → `adjust_points { email, amount: 50, reason, confirm: true }`。
18. 「我要開放儲值」→ `enable_module stored-value` → `create_topup_plan { name:"儲 1000 送 100", payAmount:1000, bonusAmount:100, bonusExpireDays:180, status:"published", confirm:true }` → `add_section topup_plans` → 發布。會員付款後自動入帳，結帳可用儲值金付款。🔴 提醒店家確認履約保證／信託義務。
19. 「網站要有英文版」→ `enable_module i18n { languages: ["en"] }` → `translate_content { lang:"en", target:{type:"page", path:"/"} }`（每頁一次；導覽 `{type:"nav"}`；文章 `{type:"post", slug}`）→ 看結果、需要時 `set_translation` 修改 → `preview_changes`（預覽網址加 /en 看英文）→ `publish_site` ＋ `publish_translations { confirm:true }`。英文網址 `/s/<slug>/en/…`。
16. 「有人匯款了」→ `list_orders { status: "pending_payment" }` → 使用者確認入帳 → `mark_order_paid { orderNo, confirm: true }` → 出貨後 `fulfill_order`。

## 工具清單

| 工具 | scope | 說明 |
|---|---|---|
| `list_modules` | — | 模組目錄（價格、依賴、區塊類型） |
| `create_site` | platform:sites | 建租戶＋開模組（自動帶依賴）＋預設首頁草稿，回傳 slug、預覽網址、網站 token |
| `issue_site_token` | platform:sites | 為網站發行限縮 scope 的 token（scopes 不能超出呼叫者自己的） |
| `get_site` | site:read | 總覽：模組、主題、導覽、頁面與區塊 id、已發布版本、草稿是否有變更 |
| `get_page` | site:read | 草稿某頁完整內容（含各區塊 props） |
| `list_section_types` | site:read | 已啟用模組的區塊類型與 props JSON Schema、範例 |
| `add_section` | content:write | 加區塊（可指定位置） |
| `update_section` | content:write | 改區塊 props（預設淺層合併，`replace` 整份取代） |
| `remove_section` | content:write | 移除區塊 |
| `move_section` | content:write | 調整區塊順序 |
| `upsert_page` | content:write | 新增／更新頁面（標題、SEO，可順便加入導覽） |
| `delete_page` | content:write | 刪頁面（首頁不可刪） |
| `update_nav` | content:write | 整份取代導覽列 |
| `update_theme` | design:write | 換預設主題／覆寫 CSS 變數 |
| `enable_module` | modules:write | 啟用模組（依賴自動帶入；設定不足為 pending_setup） |
| `disable_module` | modules:write | 停用（core、被依賴者、草稿仍在使用者會被拒） |
| `configure_module` | modules:write | 依 settingsSchema 設定模組（存進草稿，發布後生效） |
| `create_post` / `update_post` / `list_posts` | content:write / site:read | 部落格文章。公開或改已公開文章另需 publish ＋ `confirm: true` |
| `create_portfolio_item` / `update_portfolio_item` / `list_portfolio_items` | content:write / site:read | 作品集（預設 draft）。公開或改已公開作品另需 publish ＋ `confirm: true` |
| `list_inquiries` | inquiries:read | 聯絡表單詢問 |
| `list_members` / `get_member` | members:read | 會員（不回傳密碼雜湊；沒有任何改密碼的工具） |
| `disable_member` | members:write | 停用會員並撤銷所有登入（**必須** `confirm: true`） |
| `create_product` / `update_product` | commerce:write | 商品（價格 NT$ 整數、規格、庫存）。上架或改已上架商品另需 publish ＋ `confirm: true` |
| `list_products` | site:read | 商品列表（含規格與庫存） |
| `list_orders` / `get_order` | orders:read | 訂單（逾期未付會在讀取時自動取消並回補庫存） |
| `mark_order_paid` | orders:write | 線下匯款訂單標記已收款（**必須** `confirm: true`；PChomePay 訂單由 notify 回查自動更新，不能手動標） |
| `fulfill_order` | orders:write | 已付款 → 已出貨（可帶物流單號，`confirm: true`） |
| `cancel_order` | orders:write | 取消並回補庫存（`confirm: true`）；已付款訂單**不會自動退款**，回傳 note 會提示人工退款 |
| `get_payment_setup_status` | orders:read | 金流設定狀態（是否已驗證、sandbox／正式、遮罩後的 APP ID）。🔴 **沒有**設定或讀出金鑰的工具：金鑰只能由平台擁有者在後台輸入 |
| `get_invoice_setup_status` | orders:read | 發票設定狀態（模組、開立時機、憑證是否驗證、是否已設固定 IP 中繼）。🔴 **沒有**設定或讀出 Amego 金鑰的工具 |
| `list_invoices` / `get_invoice` | orders:read | 發票列表／某訂單發票（狀態、發票號、canVoid） |
| `issue_invoice` | invoices:write | 為已付款訂單開立發票（**必須** `confirm: true`；同一訂單只會有一張） |
| `retry_invoice` | invoices:write | 重試失敗的發票（先反查、已開過就認回；`confirm: true`） |
| `void_invoice` | invoices:write | 同期作廢、跨期自動改開折讓（可帶 `allowanceAmount`；`confirm: true`） |
| `get_shipping_setup_status` | orders:read | 運送方式、綠界帳號狀態（測試／正式）。🔴 **沒有**設定或讀出綠界金鑰的工具 |
| `create_shipment` | shipping:write | 建綠界物流單（訂單在物流回報寄出後自動轉已出貨）或手動出貨（帶 `trackingNumber`）；`confirm: true` |
| `get_shipment` / `list_shipments` | orders:read | 出貨單（門市、物流狀態、追蹤號、事件） |
| `create_coupon` / `update_coupon` | marketing:write | 折扣碼（固定／百分比＋上限、最低消費、期間、總次數、每人次數；停用） |
| `list_coupons` | site:read | 折扣碼與使用次數 |
| `list_referrals` | members:read | 推薦報表（推薦人、推薦數、分潤 earn−reverse） |
| `set_referral_kol` | marketing:write | 設定會員推薦碼的 KOL 分潤比例（0–50%） |
| `list_subscribers` / `list_broadcasts` | newsletter:read | 電子報訂閱者、群發紀錄與寄送統計 |
| `create_broadcast` | newsletter:write | 電子報草稿（主旨＋Markdown） |
| `send_test_broadcast` | newsletter:write | 寄測試信到指定的一個信箱 |
| `send_broadcast` | newsletter:write | 群發給已確認未退訂者（**必須** `confirm: true`；同一份只能一次；每次 50 封，`remaining > 0` 再呼叫接續） |
| `list_ai_chats` | inquiries:read | AI 客服對話摘要 |
| `create_event` / `update_event` | classes:write | 活動（預設草稿；上架或改已上架活動另需 publish ＋ `confirm: true`） |
| `create_session` / `create_ticket_type` | classes:write | 場次（時間、容量、手動保留座位）／票種（價格 0＝免費、每單上限、販售期間、配額）；活動已上架時需 publish ＋ confirm |
| `list_events` | site:read | 活動、場次、票種、即時名額（已報名、保留、候補、剩餘） |
| `list_registrations` | attendees:read | 名單（聯絡資料遮罩；完整資料與 CSV 只在後台並留紀錄） |
| `check_in` | attendees:write | 簽到（registrationId 或簽到碼；`confirm: true`） |
| `create_service` / `update_service` | classes:write | 預約服務（時長、緩衝、價格、付款方式 none／deposit／full）；上架或改已上架服務需 publish ＋ confirm |
| `list_services` | site:read | 服務、提供者、每週時段、預約設定 |
| `set_weekly_hours` | classes:write | 整份取代每週可預約時段（台北，HH:MM，可多段）；**publish ＋ `confirm: true`** |
| `add_date_override` | classes:write | 例外日：休假 closed／加開 open；**publish ＋ `confirm: true`** |
| `get_booking_availability` | site:read | 某服務接下來幾天的可預約時段 |
| `list_bookings` | attendees:read | 預約列表（聯絡資料遮罩） |
| `cancel_booking` | attendees:write | 店家取消預約並通知客人（附取消 .ics）；已付款標待退款（`confirm: true`） |
| `create_course` / `update_course` | classes:write | 線上課程（價格 0＝免費）；上架或改已上架課程需 publish ＋ confirm |
| `add_lesson` / `update_lesson` | classes:write | 單元（影片只接受 YouTube／Vimeo、Markdown、附件、免費試看）；課程已上架時需 publish ＋ confirm |
| `list_courses` | site:read | 課程、單元、開通人數 |
| `grant_course` / `revoke_course` | attendees:write | 手動開通／撤銷會員的課程存取權（`confirm: true`；撤銷不退款） |
| `list_enrollments` | attendees:read | 學員（email 遮罩、來源、完成單元數） |
| `cancel_session` | classes:write | 取消場次並通知所有人；已付款者標待退款、不自動退款（`confirm: true`） |
| `get_member_points` | members:read | 會員點數：餘額、可用、即將到期批次（FIFO）、等級、帳本 |
| `adjust_points` | members:write | 手動加／扣點（理由必填；扣點不能超過可用；**必須** `confirm: true`） |
| `list_tiers` | site:read | 會員等級（已發布／草稿）與各等級人數 |
| `update_tiers` | modules:write | 整份取代等級（進草稿，發布後生效） |
| `get_member_balance` | members:read | 會員儲值金：餘額、可用、贈送額度到期、帳本 |
| `adjust_balance` | members:write | 手動增減儲值金（理由必填；扣款不能超過可用；**必須** `confirm: true`） |
| `create_topup_plan` / `update_topup_plan` | commerce:write | 儲值方案（付 X 得 X＋贈送、贈送到期天數）；上架或改已上架需 publish ＋ confirm |
| `list_topup_plans` | site:read | 儲值方案列表 |
| `translate_content` | content:write | AI 翻譯頁面／導覽／文章／商品／活動／課程（只翻文字欄位、進草稿、標記 AI；每日上限） |
| `set_translation` | content:write | 手動翻譯或修改（key：title、seoTitle、seoDescription、s.<區塊id>.<欄位>、nav.<i>、或模組資料欄位；null＝刪除） |
| `list_translations` | site:read | 翻譯進度（每語言 × 每頁、模組資料草稿／已發布） |
| `publish_translations` | publish | 模組資料翻譯上線（**必須** `confirm: true`）；頁面翻譯跟著 `publish_site` |
| `create_person` / `update_person` | content:write | 人員名錄（姓名、職稱、分類、照片、簡介、聯絡方式預設不公開）；上架或改已上架需 publish ＋ confirm |
| `list_people` | site:read | 人員與分類 |
| `create_document_upload` | content:write | 新增文件並取得簽名上傳網址（PUT 檔案，≤ 50MB；檔名淨化、副檔名白名單） |
| `complete_document_upload` | content:write | 確認檔案已上傳（伺服器檢查存在與大小）；`publish: true` 上架需 publish ＋ confirm |
| `update_document` | content:write | 標題、分類、公開／限會員、上下架（已上架或要上架需 publish ＋ confirm） |
| `list_documents` | site:read | 文件與下載次數 |
| `import_certificates` | certificates:write | 匯入證照 CSV（先 dryRun；公式開頭拒絕；有錯整份不匯入；`confirm: true` 寫入） |
| `list_certificates` | certificates:read | 證照列表（姓名遮罩、不含生日；證號容錯查單筆） |
| `set_certificate_status` | certificates:write | 有效／撤銷／停權（`confirm: true`） |
| `list_certificate_lookups` | certificates:read | 公開查詢紀錄（不含查詢內容） |
| `list_reviews` | site:read | 商品評價（評價者遮罩；pending 待審核） |
| `moderate_review` | reviews:write | 公開／隱藏評價（`confirm: true`） |
| `reply_review` | reviews:write | 店家回覆（純文字；`confirm: true`） |
| `create_announcement` / `update_announcement` | content:write | 公告（置頂、上下架時間、僅會員、必讀確認）；發布或改已發布需 publish ＋ confirm |
| `list_announcements` | site:read | 公告、是否上線、必讀確認人數 |
| `list_announcement_acks` | members:read | 必讀確認名單（遮罩） |
| `preview_changes` | site:read | 草稿 vs 已發布差異、發布前驗證、預覽網址 |
| `publish_site` | publish | 發布草稿為新版本（**必須** `confirm: true`；建議帶 `expectedDraftVersion`，預覽後草稿被改過就拒絕） |
| `list_revisions` | site:read | 版本列表 |
| `rollback` | publish | 還原到指定版本並同步草稿（**必須** `confirm: true`） |

錯誤一律以工具結果 `isError: true` 回傳，文字格式 `[code] 說明`，code 為 `forbidden`、`not_found`、`invalid`、`conflict`、`confirm_required`、`rate_limited`。
