# 模組規格：新增一個模組

模組註冊表（`modules/registry.ts`）是唯一真相。平台首頁目錄、`list_modules`、依賴解析、區塊驗證都從它讀。

## 檔案

```
modules/<id>/
  manifest.ts      # 匯出 manifest: ModuleManifest（純 TS，不 import React —— 測試與 MCP 會載入）
  sections.tsx     # 區塊渲染元件（server component；需要互動的拆成 "use client" 子元件）
  *.tsx            # 其他 client 元件
```

`ModuleManifest`（`modules/types.ts`）：

| 欄位 | 說明 |
|---|---|
| `id` | 小寫英數與連字號，全平台唯一 |
| `name` / `description` | 給人與 agent 看（`list_modules` 會回傳） |
| `category` | foundation / content / engagement / commerce |
| `priceSetup` / `priceMonthly` | 新台幣 |
| `requires` | 依賴模組 id；開啟時自動帶入，循環會被拒 |
| `settingsSchema` | zod；`configure_module` 依它驗證。`{}` 不通過 → 啟用後狀態為 `pending_setup` |
| `sectionTypes` | `{ type, label, description, schema, example }[]`；`schema` 是 props 的 zod（`.strict()`），`example` 必須通過 schema |
| `adminPages?` / `mcpTools` | 宣告用 |
| `locked?` | 不可停用（只有 core） |

## Checklist

1. 建 `modules/<id>/manifest.ts`，props schema 一律 `.strict()`；連結用 `safeHref`、圖片用 `imageUrl`（`lib/validators.ts`），不接受原始 HTML。
2. 在 `modules/registry.ts` 的 `MODULES` 加入。
3. 渲染元件寫在 `modules/<id>/sections.tsx`，型別 `SectionComponent`；站內連結一律經 `siteHref(ctx, href)`（預覽模式會保留簽章）。
4. 在 `modules/renderers.tsx` 註冊 `type → 元件`（`tests/renderers.test.ts` 會檢查每個 sectionType 都有渲染元件）。
5. 需要資料表：新 migration `supabase/migrations/NNNN_*.sql`，表名 `builder_` 開頭、帶 `tenant_id`、開 RLS、不建 anon/authenticated policy、grant 給 `service_role`；在 `lib/store/types.ts` 加方法並實作 Supabase 與 memory 兩版。
6. 需要 MCP 工具：服務函式寫在 `lib/services/`（第一行 `requireScope`、寫入後 `audit`、用 `resolveTenant` 隔離），再到 `lib/mcp/tools.ts` 註冊；描述要寫清楚「何時用、參數意義、需要哪個 scope」。
7. 公開端點（例如表單送出）：在 `app/api/s/[site]/…`，檢查模組已啟用、輸入 zod 驗證、需要時限流。
8. 測試：至少涵蓋 props 驗證與服務層權限；`npm test`、`npm run typecheck`、`npm run build` 全過。
9. 手機 375px 無水平捲動。
