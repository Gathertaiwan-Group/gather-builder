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
| `settingsSchema` | zod；`configure_module` 依它驗證，設定存進草稿 `moduleSettings`、發布後生效。渲染時用 `moduleConfig(site, id)` 讀（讀的是目前顯示的快照）。`{}` 不通過 → 啟用後狀態為 `pending_setup` |
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

10. 模組固定路徑（例如 `/shop`、`/account`）要加進 `lib/validators.ts` 的 `RESERVED_PATHS`，避免租戶自建同名頁面。
11. 需要讀「目前登入的會員」的公開 POST：路由放在 `app/s/[site]/api/…`（會員 cookie 的 path 是 `/s/<slug>`，放 `/api/…` 收不到），用 `originOk()` 檢查 Origin、`memberTokenFromRequest()` 讀 cookie。
12. 有錢、庫存、狀態轉換的寫入：一律 DB 條件式更新或 SQL 函式（單一交易），memory store 要實作同語意；並在 `tests/integration/` 補一支打真 DB 的併發測試。

## 已實作模組速覽

| id | 依賴 | 固定頁面 | 資料表 | MCP 工具 |
|---|---|---|---|---|
| `members` | core | `/account`、`/account/login`、`register`、`forgot`、`reset?token=`、`verify?token=` | `builder_members`、`builder_member_sessions`、`builder_member_tokens` | `list_members`、`get_member`、`disable_member` |
| `shop` | core、members | `/shop`、`/shop/<slug>`、`/checkout`、`/orders/<訂單編號>` | `builder_products`、`builder_product_variants`、`builder_orders`、`builder_order_items`、`builder_order_counters`、`builder_payment_accounts`、`builder_payments` | `create_product`、`update_product`、`list_products`、`list_orders`、`get_order`、`mark_order_paid`、`fulfill_order`、`cancel_order`、`get_payment_setup_status` |

`shop` 的設定（`configure_module`，進草稿、發布後生效）：`shippingFee`、`freeShippingThreshold`、`ownerEmail`、`orderPrefix`、`orderExpireHours`（預設 72）、`allowGuestCheckout`、`offlineTransfer {enabled, instructions}`、`pchomepay`、`onlinePaymentHoldMinutes`（線上刷卡保留，預設 60）、`pchomepayAtm`（另提供 ATM）、`maxQtyPerItem`（預設 10）。
**金流金鑰不在模組設定裡**：只能由平台擁有者在後台「金流設定」分頁輸入（見 ARCHITECTURE「金流」）。
`shop` 的狀態除了 settingsSchema 之外還看金流：沒有已驗證的 PChomePay 憑證 → `pending_setup`（`lib/shop/status.ts`），區塊照常顯示，結帳只提供已開放的線下匯款；兩種付款都沒開則結帳頁顯示「尚未開放結帳」。

### 下一批（這次刻意不做，資料結構已預留）

- **發票**：`builder_orders.invoice_status`（null = 未處理）。發票模組接 `onOrderPaid`（`lib/services/orders.ts`）之後開立，狀態寫回此欄。
- **物流**：`builder_orders.shipping_method`、`shipping_tracking`（`fulfill_order` 已可寫入單號）。物流模組要做的是運費規則（目前只有固定運費＋滿額免運）與托運單串接。
- **行銷**：折扣碼／活動價要在 `priceCart()`（server 端計價唯一入口）加一步，前端仍然不能決定價格。
- **退款**：目前取消已付款訂單不會自動退款（會清楚提示需到 PChomePay 後台人工退款）。
