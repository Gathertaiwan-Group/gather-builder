# gather-builder

給樂數位（Gather）的多租戶、模組化建站平台：骨架＋形象站模組＋會員（members）＋電商核心（shop：商品、購物車、結帳、訂單、多家金流：PChomePay、藍新、綠界、LINE Pay、黑貓 PAY、PAYUNi，含退款）＋電子發票（invoice）、物流（shipping）、行銷（coupons、referral、newsletter、ai-chat）＋課程類（events 活動報名、booking 時段預約、courses 線上課程）＋會員經營（loyalty 點數＋等級、stored-value 儲值金）＋內容與在地（i18n 多語＋AI 翻譯、search、directory、downloads、certificates、reviews、announcements）＋訂閱制（subscriptions：藍新信用卡定期定額）＋團購（group-buy：團主分潤、銀行明細對帳、結團、出貨匯出）＋實體門市 QR 多語商品頁（qr-catalog：掃碼分析、品牌報表）＋MCP server。

- 網站內容存成結構化 JSON（頁面 → 區塊 → props），agent 只能改區塊與內容、不能改程式碼。
- 一層服務函式（`lib/services/`）、兩個入口：後台（`/admin`）與 MCP（`/api/mcp`）。
- 所有修改先進草稿 → `preview_changes` 給預覽網址 → `publish_site confirm:true` 才上線；每次發布留版本，可 `rollback`。

## 本機開發

```bash
npm install
cp .env.example .env.local   # 填入下方環境變數
npm run dev                  # http://localhost:3000
```

| 指令 | 說明 |
|---|---|
| `npm run build` / `npm start` | 正式建置 / 啟動 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest 單元測試（記憶體 Store，不連資料庫） |
| `npm run test:db` | 整合測試：Supabase 實作與 builder_publish/rollback/rate_hit（建 is_test 租戶，跑完刪除） |
| `SUPABASE_ACCESS_TOKEN=… npm run migrate` | 透過 Management API 套用 `supabase/migrations/*.sql` |
| `node --env-file=.env.local scripts/issue-platform-token.mjs "名稱" --save-env .env.local` | 發行平台級 MCP token（原文寫入 env 檔，不印在終端） |
| `node --env-file=.env.local scripts/e2e-mcp.mjs http://localhost:3100` | MCP 端到端（開站→改→發布→改版→還原）；`--quick` 為精簡版 |
| `node --env-file=.env.local scripts/e2e-security.mjs http://localhost:3100` | 隔離、scope、401、聯絡表單、honeypot、限流、後台撤銷 token |
| `node --env-file=.env.local scripts/e2e-shop.mjs http://localhost:3100` | 會員＋電商端到端（開站→商品→會員註冊/登入→結帳（線下匯款）→收款→出貨→會員中心）；`--quick` 為正式站精簡版 |
| `PCHOMEPAY_SANDBOX_APP_ID=… PCHOMEPAY_SANDBOX_SECRET=… node --env-file=.env.local scripts/e2e-pchomepay-sandbox.mjs http://localhost:3100` | 只限本機＋sandbox：後台輸入測試金鑰→驗證→（沒有預覽簽章被拒）→帶預覽簽章結帳 303 到 sandbox 付款頁（不刷卡） |
| `node --env-file=.env.local scripts/e2e-marketing.mjs http://localhost:3100` | 第三批端到端：開站→shop＋coupons＋shipping＋invoice（mock 供應商）→商品與折扣碼→會員結帳套券→收款→開發票→手動出貨→會員中心看到發票號與追蹤號；`--quick` 為正式站精簡版（+ `--newsletter-test` 寄一封測試電子報到 gathertaiwan@gmail.com；不知道正式站後台密碼時用 `--admin-base=http://localhost:3210` 讓後台動作打共用同一個 DB 的本機） |
| `node --env-file=.env.local scripts/e2e-classes.mjs http://localhost:3210` | 第四批端到端：events（容量 1、付費保留、候補遞補、CSV）＋booking（每週時段、同時段被拒、.ics）＋courses（未付款 HTML 不含影片網址、付款後開通上課）；需要 `SUPABASE_URL`／`SUPABASE_SERVICE_ROLE_KEY`（測試用時間注入，只改這次建立的 is_test 租戶）與 `PREVIEW_SECRET`（重算遞補連結）。`--quick` 跳過遞補認領 |
| `node --env-file=.env.local scripts/ensure-buckets.mjs` | 建立 Storage bucket（只建 builder- 開頭：`builder-downloads` 私有、50MB），冪等 |
| `node --env-file=.env.local scripts/e2e-content.mjs http://localhost:3220` | 第五、六批端到端：開站（13 模組）→ 賺點 → 點數折抵（990）→ 儲值（線下匯款入帳）→ 儲值金全額付款 → AI 翻譯首頁（無 key 時 is_test 用 mock）→ /en 英文＋hreflang → 搜尋 → 證照查詢 → 限會員文件 → 評價審核 → 必讀公告確認。需要 2026-10-19 後發行的 `GB_PLATFORM_TOKEN`（含 certificates:*／reviews:write）；正式站同一支可直接跑 |
| `npx tsx scripts/e2e-ecpay-stage.mts` | 綠界物流 **stage**（官方公開測試特店）：電子地圖、建立測試物流單、模擬狀態通知（記憶體 Store，不寫 DB） |
| `npx tsx scripts/amego-test-env.mts [--issue]` | Amego **官方公開測試公司**（統編 12345678）：驗證／（--issue）開立→反查→重複 OrderId→作廢、折讓 |

## 環境變數

| 名稱 | 必要 | 說明 |
|---|---|---|
| `SUPABASE_URL` | ✓ | Supabase 專案網址 |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | service role key（只在 server 端用；所有表 RLS 開啟且無 policy） |
| `ADMIN_PASSWORD` | ✓ | 後台登入密碼 |
| `ADMIN_SESSION_SECRET` | ✓ | 後台 cookie HMAC 金鑰（≥16 字） |
| `PREVIEW_SECRET` | ✓ | 預覽連結簽章與 IP 雜湊金鑰 |
| `APP_URL` | 建議 | 對外網址，用來產生預覽連結；沒設就用 request 的 host |
| `RESEND_API_KEY` | 正式站必要 | 會員驗證信、重設密碼、訂單信、電子報、聯絡表單通知。沒設時信件不寄（只寫 log）。RFC 2606 保留網域（example.com、.test…）一律不寄 |
| `RESEND_FROM` | 選填 | 寄件者 |
| `PAYMENT_ENC_KEY` | shop 必要 | 金流憑證加密金鑰（32 bytes，base64 或 64 位 hex，`openssl rand -base64 32`）。換掉會讓既有憑證解不開（需重新輸入） |
| `CRON_SECRET` | shop 建議 | 每日逾期訂單 cron（`/api/cron/expire-orders`）的 Bearer 金鑰（≥16 字） |
| `AMEGO_RELAY_URL` / `AMEGO_RELAY_SECRET` | invoice 正式使用必要 | Amego 固定 IP 中繼網址與共享密鑰（header `x-relay-secret`）。沒設＝直連（Amego 會擋浮動 IP） |
| `GEMINI_API_KEY` | ai-chat、i18n AI 翻譯必要 | 沒設時 ai-chat 為 pending_setup、前台不顯示；i18n 只能手動翻譯（is_test 網站用 mock 翻譯供 e2e） |
| `GEMINI_MODEL` | 選填 | 預設 `gemini-2.5-flash`；新 key 若 404 改 `gemini-3.5-flash` |
| `PLATFORM_SITES_DOMAIN` | 選填（第九批） | 租戶子網域的根網域，例如 `sites.gathertaiwan.com`。🔴 要先設好 wildcard DNS 與 Vercel wildcard 網域才設，否則信件與預覽連結會指到打不開的網址。沒設＝維持 `/s/<slug>` |
| `PLATFORM_EXTRA_HOSTS` | 選填 | 其他也算「平台」的 host（逗號分隔），例如 `builder.gathertaiwan.com` |
| `VERCEL_DOMAINS_TOKEN` / `VERCEL_DOMAINS_PROJECT_ID` / `VERCEL_DOMAINS_TEAM_ID` | 自有網域 | Vercel API token 與專案／team id（自有網域加到專案、查驗證狀態）。沒設＝後台無法新增自有網域 |
| `DOMAIN_ADAPTER` | 只給本機／e2e | `mock`＝自有網域不打 Vercel（`.test` 網域自動驗證） |
| `SUPABASE_ACCESS_TOKEN` | 只給 migrate 腳本 | Management API token，**不要**放進 Vercel 或 repo |
| `GB_PLATFORM_TOKEN` | 只給 e2e 腳本 | 平台級 MCP token |

## 資料庫

共用 Supabase 專案，所有物件放 `public` 且一律 `builder_` 前綴（見 `supabase/migrations/`）。
🔴 不要用 `supabase db push`（會試圖對齊整個共用 schema），一律用 `scripts/apply-migrations.mjs`。

## 文件

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：多租戶、草稿/發布/版本、一層服務兩個入口、擴充點
- [docs/MODULE-SPEC.md](docs/MODULE-SPEC.md)：新增模組的檔案與 checklist
- [docs/MCP.md](docs/MCP.md)：MCP 連線方式與工具清單

## 部署

**自動部署**：push 到 main 會觸發 GitHub Actions（`.github/workflows/deploy.yml`）：typecheck → test → 移除 `.git` 後 `vercel deploy --prod`。
需要的 repo secrets：`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。

**手動部署（備援）**：直接在 repo 目錄 `vercel deploy --prod` 會因為 commit 作者不是 Vercel team 成員而被擋（BLOCKED / TEAM_ACCESS_REQUIRED），
所以要從不含 `.git` 的匯出目錄部署：

```bash
D=$(mktemp -d) && git archive HEAD | tar -x -C "$D" && mkdir -p "$D/.vercel" && cp .vercel/project.json "$D/.vercel/"
(cd "$D" && vercel deploy --prod --yes --scope armands-projects-f3e1a37d)
```

有 DB 變更時：先 `npm run migrate`，再部署。若變更會讓線上舊版程式壞掉（例如改函式簽章），要先放相容層（參考 migrations 0004/0005）。

## 第八批：團購與 QR 多語商品頁

- 團購（group-buy）：`docs/ARCHITECTURE.md`「團購」。QR 多語商品頁（qr-catalog）：`docs/ARCHITECTURE.md`「實體門市 QR 多語商品頁」。端到端：`node --env-file=.env.local scripts/e2e-groupbuy.mjs http://localhost:3240`（含 qr-catalog；`--no-qr` 只跑團購；`--quick` 略過複製團購）。

## 第七批：多家金流與訂閱

- 金流 provider 介面與各家安全規則：`docs/ARCHITECTURE.md`「金流 provider（第七批）」。
- 綠界金流官方測試特店 stage 實測：`npx tsx scripts/e2e-ecpay-payment-stage.mts`（只打 payment-stage、不付款、callback 自行簽章模擬）。
- 訂閱制：`enable_module subscriptions`（需已驗證的藍新憑證並向藍新開通信用卡定期定額）→ `create_subscription_plan` → 區塊 `subscription_plans`。
