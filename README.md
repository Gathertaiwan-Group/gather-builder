# gather-builder

給樂數位（Gather）的多租戶、模組化建站平台第一版：骨架＋形象站模組＋MCP server。

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

## 環境變數

| 名稱 | 必要 | 說明 |
|---|---|---|
| `SUPABASE_URL` | ✓ | Supabase 專案網址 |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | service role key（只在 server 端用；所有表 RLS 開啟且無 policy） |
| `ADMIN_PASSWORD` | ✓ | 後台登入密碼 |
| `ADMIN_SESSION_SECRET` | ✓ | 後台 cookie HMAC 金鑰（≥16 字） |
| `PREVIEW_SECRET` | ✓ | 預覽連結簽章與 IP 雜湊金鑰 |
| `APP_URL` | 建議 | 對外網址，用來產生預覽連結；沒設就用 request 的 host |
| `RESEND_API_KEY` | 選填 | 有設才寄聯絡表單通知信（收件人在 contact-form 模組設定 `notifyEmail`） |
| `RESEND_FROM` | 選填 | 寄件者 |
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
