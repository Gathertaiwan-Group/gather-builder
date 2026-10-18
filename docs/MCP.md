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

> 新 scope 是 2026-10 加的：之前發行的 token 沒有這些 scope，需重新發行（`create_site` 發出的 token 取呼叫者 scope 的交集）。
> 第三批（invoices／shipping／marketing／newsletter）的 scope 於 2026-10-19 加入，同樣需要重新發行 token 才拿得到。

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
13. 「有人匯款了」→ `list_orders { status: "pending_payment" }` → 使用者確認入帳 → `mark_order_paid { orderNo, confirm: true }` → 出貨後 `fulfill_order`。

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
| `preview_changes` | site:read | 草稿 vs 已發布差異、發布前驗證、預覽網址 |
| `publish_site` | publish | 發布草稿為新版本（**必須** `confirm: true`；建議帶 `expectedDraftVersion`，預覽後草稿被改過就拒絕） |
| `list_revisions` | site:read | 版本列表 |
| `rollback` | publish | 還原到指定版本並同步草稿（**必須** `confirm: true`） |

錯誤一律以工具結果 `isError: true` 回傳，文字格式 `[code] 說明`，code 為 `forbidden`、`not_found`、`invalid`、`conflict`、`confirm_required`、`rate_limited`。
