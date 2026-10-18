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
| `shop` | core、members | `/shop`、`/shop/<slug>`、`/checkout`、`/orders/<訂單編號>` | `builder_products`、`builder_product_variants`、`builder_orders`、`builder_order_items`、`builder_order_counters`、`builder_payment_accounts`、`builder_payments`、`builder_refunds` | `create_product`、`update_product`、`list_products`、`list_orders`、`get_order`、`mark_order_paid`、`fulfill_order`、`cancel_order`、`refund_order`、`get_payment_setup_status` |

`shop` 的| `i18n` | core | `/s/<slug>/<lang>/…`（所有頁面）；語言切換；後台「多語」 | `builder_translations`；頁面翻譯在 `content.translations` | `translate_content`、`set_translation`、`list_translations`、`publish_translations` |
| `search` | core | `/search?q=`；區塊 `search_box` | （函式 `builder_search_content`） | — |
| `directory` | core | `/people`（`?category=` 篩選）、`/people/<slug>`；區塊 `people_grid` | `builder_people`（聯絡方式 `show_contact` 才公開） | `create_person`、`update_person`、`list_people` |
| `downloads` | core | `/downloads`、`/downloads/<id>`（權限檢查後 302 到 60 秒簽名網址）；區塊 `downloads_list`；後台「文件」 | `builder_documents`；Storage 私有 bucket `builder-downloads` | `create_document_upload`、`complete_document_upload`、`update_document`、`list_documents` |
| `certificates` | core | `/verify`、`/api/s/<slug>/verify`（JSON）；區塊 `certificate_lookup`；後台「證照」（CSV 匯入） | `builder_certificates`、`builder_cert_lookups`（只增不改） | `import_certificates`、`list_certificates`、`set_certificate_status`、`list_certificate_lookups` |
| `reviews` | shop、members | 商品頁評價（平均分、列表、評價表單）、`/s/<slug>/api/reviews`；區塊 `product_reviews`；後台「評價」 | `builder_reviews`（unique 訂單×商品） | `list_reviews`、`moderate_review`、`reply_review` |
| `subscriptions` | members、shop | 區塊 `subscription_plans`、`/s/<slug>/api/subscriptions/subscribe`、`/s/<slug>/api/subscriptions/cancel`、`/api/subscriptions/newebpay/notify/<tenantId>`（＋return）；會員中心「我的訂閱」；後台「訂閱」 | `builder_subscription_plans`、`builder_subscriptions`、`builder_subscription_charges`（只增不改） | `create_subscription_plan`、`update_subscription_plan`、`list_subscription_plans`、`list_subscriptions`、`cancel_subscription` |
| `announcements` | core | `/announcements`、`/s/<slug>/api/announcements/ack`；外框必讀橫幅；區塊 `announcements_bar`、`announcements_list`；後台「公告」（確認名單） | `builder_announcements`、`builder_announcement_acks`（只增不改） | `create_announcement`、`update_announcement`、`list_announcements`、`list_announcement_acks` |
| `stored-value` | members、shop | `/wallet`（方案與購買）、`/s/<slug>/api/wallet/topup`；結帳「儲值金」；會員中心「我的儲值金」；區塊 `topup_plans`；後台「會員經營」 | `builder_wallet_ledger`（只增不改）、`builder_topup_plans` | `get_member_balance`、`adjust_balance`、`create_topup_plan`、`update_topup_plan`、`list_topup_plans` |
| `loyalty` | members、shop | 結帳「點數折抵」；會員中心「我的點數」；區塊 `loyalty_tiers` | `builder_points_ledger`（只增不改）、`builder_member_tiers`；訂單欄位 `tier_discount`／`points_redeemed`／`points_discount`／`wallet_paid` | `get_member_points`、`adjust_points`、`list_tiers`、`update_tiers` |

設定（`configure_module`，進草稿、發布後生效）：`shippingFee`、`freeShippingThreshold`、`ownerEmail`、`orderPrefix`、`orderExpireHours`（預設 72）、`allowGuestCheckout`、`offlineTransfer {enabled, instructions}`、`pchomepay`、`onlinePaymentHoldMinutes`（線上刷卡保留，預設 60）、`pchomepayAtm`（另提供 ATM）、`maxQtyPerItem`（預設 10）。
**金流金鑰不在模組設定裡**：只能由平台擁有者在後台「金流設定」分頁輸入（見 ARCHITECTURE「金流」）。
`shop` 的狀態除了 settingsSchema 之外還看金流：沒有任何一家已驗證的金流憑證（PChomePay、藍新、綠界、LINE Pay、黑貓 PAY、PAYUNi）→ `pending_setup`；`subscriptions` 要已驗證的藍新憑證才 `enabled`（`lib/shop/status.ts`），區塊照常顯示，結帳只提供已開放的線下匯款；兩種付款都沒開則結帳頁顯示「尚未開放結帳」。

`invoice`／`shipping`／`coupons`／`referral`／`newsletter`／`ai-chat` 的細節見下表與 ARCHITECTURE「發票」「物流」「行銷」。

| id | 依賴 | 固定頁面／端點 | 資料表 | MCP 工具 |
|---|---|---|---|---|
| `invoice` | shop | 結帳頁發票欄位；後台「電子發票」 | `builder_invoice_accounts`、`builder_invoices`（order_id 唯一） | `get_invoice_setup_status`、`list_invoices`、`get_invoice`、`issue_invoice`、`retry_invoice`、`void_invoice` |
| `shipping` | shop | `/s/<slug>/api/shipping/cvs-start`、`/api/ship/ecpay/map/<tenantId>`、`/api/ship/ecpay/notify/<tenantId>`；後台「物流」 | `builder_shipping_accounts`、`builder_cvs_selections`、`builder_shipments` | `get_shipping_setup_status`、`create_shipment`、`get_shipment`、`list_shipments` |
| `coupons` | shop | 結帳頁折扣碼；後台「行銷」 | `builder_coupons`、`builder_coupon_redemptions`、`builder_coupon_user_counts` | `create_coupon`、`update_coupon`、`list_coupons` |
| `referral` | members、coupons | `/s/<slug>/api/ref/<碼>`（分享連結）；會員中心；後台「行銷」 | `builder_referral_codes`、`builder_referrals`、`builder_referral_ledger`（只增不改） | `list_referrals`、`set_referral_kol` |
| `newsletter` | core | 區塊 `newsletter_signup`；`/api/s/<slug>/newsletter`、`/s/<slug>/newsletter/confirm`、`/newsletter/unsubscribe`；後台「電子報」 | `builder_newsletter_subscribers`、`builder_newsletter_broadcasts`、`builder_newsletter_deliveries` | `list_subscribers`、`create_broadcast`、`send_test_broadcast`、`send_broadcast`、`list_broadcasts` |
| `ai-chat` | core | 右下角客服；`/api/s/<slug>/ai-chat`；後台「AI 客服」 | `builder_ai_chats` | `list_ai_chats` |

| `events` | core（付費票需 shop；會員選用） | `/events`、`/events/<slug>`（`?offer=&t=` 候補遞補）；`/s/<slug>/api/events/register`、`/api/events/waitlist`；會員中心「我的報名」；後台「活動」（名單遮罩、查看、CSV、簽到、取消場次） | `builder_events`、`builder_event_sessions`、`builder_event_ticket_types`、`builder_event_registrations`、`builder_event_waitlist`、`builder_pii_access_log` | `create_event`、`update_event`、`create_session`、`create_ticket_type`、`list_events`、`list_registrations`、`check_in`、`cancel_session` |

| `booking` | core（線上收訂金／全額需 shop） | `/book`（`?service=&from=&slot=`）、`/book/manage?b=&t=`（自助取消／改期）、`/book/ics?b=&t=`；`/s/<slug>/api/booking/book`、`/api/booking/manage`；會員中心「我的預約」；後台「預約」週曆 | `builder_booking_providers`、`builder_booking_services`、`builder_booking_hours`、`builder_booking_overrides`、`builder_bookings` | `create_service`、`update_service`、`list_services`、`set_weekly_hours`、`add_date_override`、`get_booking_availability`、`list_bookings`、`cancel_booking` |

| `courses` | core、members（付費課程需 shop） | `/courses`、`/courses/<slug>`、`/learn/<課程>/<單元>`；`/s/<slug>/api/courses/buy`、`/api/courses/progress`；會員中心「我的課程」；後台「課程」（手動開通／撤銷、學員） | `builder_courses`、`builder_course_lessons`、`builder_course_enrollments`、`builder_course_progress` | `create_course`、`update_course`、`add_lesson`、`update_lesson`、`list_courses`、`grant_course`、`revoke_course`、`list_enrollments` |

設定（`configure_module`，進草稿、發布後生效）：
- `loyalty`：`earnPerAmount`（每 X 元 1 點，預設 100）、`pointValue`（1 點＝N 元，預設 1）、`maxRedeemPercent`（單筆折抵上限 %，預設 50）、`redeemEnabled`、`pointsExpireDays`（預設 365）、`tierWindowMonths`（預設 12，0＝累計）、`tiers[]`（`id` 比對鍵、`name`、`minSpend`、`multiplier`、`discountPercent`、`perks`）。全部有預設，`{}` 即啟用。
- `i18n`：`languages`（en、ja、ko、zh-cn、th、vi、id、fr、de、es）、`aiDailyLimit`（預設 50）、`glossary`（給 AI 的專有名詞指引）。新區塊類型的文字欄位會自動成為可翻譯欄位；比對用的 props 請命名為 `*Slug`／`*Id`／`*Url`／`*Href` 或 slug／id／code 等（`lib/i18n/translatable.ts` 會排除）。
- `stored-value`：`ownerEmail`、`notice`（儲值頁注意事項，例如履約保證說明）。🔴 儲值金屬預收款，上線前店家須確認履約保證／信託義務。
- `courses`：`ownerEmail`。區塊 `courses_list`、`course_detail`。
- `booking`：`minLeadMinutes`（預設 120）、`maxAdvanceDays`（60）、`slotStepMinutes`（30）、`cancelDeadlineHours`（24）、`location`、`ownerEmail`、`allowGuest`、`reminders`、`freeBookingsPerEmailPerDay`（每 email 每天免費預約上限，預設 2）。區塊 `booking_widget`。
- `events`：`waitlistOfferHours`（1–72，預設 24）、`reminders`（預設 true）、`ownerEmail`（不填用 shop 的）、`allowGuest`（預設 true）、`requireEmailConfirm`（免費報名／候補需 email 確認，預設 true）。區塊 `events_list`、`event_detail`。固定頁面另有 `/events/confirm`（email 確認）。
- `invoice`：`issueMode`（`manual` 預設／`auto_on_paid`）、`allowMobileBarcode`、`allowCertificate`、`allowDonation`、`allowB2B`、`defaultLoveCode`。憑證不在設定裡。沒有已驗證憑證 → `pending_setup`。
- `shipping`：`methods[]`（`id`、`type` cvs／home／pickup／manual、`provider` ecpay／manual、`subType`、`label`、`fee`、`freeThreshold`、`instructions`）、`sender`（使用綠界時必填）、`goodsName`。`methods` 至少一種，否則 `pending_setup`。
- `coupons`：無設定（折扣碼用 MCP／後台建立）。
- `referral`：`rewardCoupon { kind, value, maxDiscount, minSubtotal, validDays }`（必填，否則 `pending_setup`）、`rewardMonthlyLimit`（每位推薦人每月回饋上限，預設 10）、`kolEnabled`。
- `newsletter`：`footer`、`rateLimitPerHour`。
- `ai-chat`：`assistantName`、`greeting`、`extraKnowledge`、`perIpDailyLimit`（30）、`dailyLimit`（300）、`collectLeads`。平台沒設 `GEMINI_API_KEY` → `pending_setup`。

模組間的副作用（付款成功、訂單取消）走 `lib/services/order-hooks.ts` 註冊，各 hook 自己冪等、失敗不影響主流程；發票自動開立直接在 `onOrderPaid` 呼叫。

| `group-buy` | shop | `/groupbuy/<slug>`（`?leader=<碼>` 團主連結）、`/groupbuy/leader?l=&t=`（團主簽章報表）、`/s/<slug>/api/groupbuy/order`、`/api/groupbuy/report-transfer`（訂單頁回報匯款末五碼）；區塊 `group_buy_list`、`group_buy_detail` | `builder_group_buys`、`builder_group_buy_items`（限量 sold ≤ quota）、`builder_group_buy_leaders`、`builder_group_buy_leader_assignments`、`builder_group_buy_orders`、`builder_group_buy_commissions`／`builder_group_buy_notices`（只增不改）、`builder_bank_imports`、`builder_bank_lines`、`builder_bank_matches`；訂單欄位 `group_buy_id`／`group_buy_leader_id` | `create_group_buy`、`update_group_buy`、`duplicate_group_buy`、`list_group_buys`、`get_group_buy`、`invite_leader`、`list_group_buy_orders`、`import_bank_statement`、`confirm_bank_matches`、`close_group_buy`、`export_shipping`、`create_group_buy_shipments` |

- `group-buy` 設定：`orderRateLimitPerHour`（團購下單每 IP 每小時，預設 20）、`bankMatchWindowDays`（匯款日期在下單日後幾天內才配對，預設 7）、`paymentNote`。

### 尚未做

- **退款**：取消已付款訂單仍不會自動退款（PChomePay 需人工）；發票作廢／折讓已可用。
- **多張折扣碼併用**、**活動價**、**超商取貨付款（COD）**、**逆物流**、**電子報 HTML 版型與排程寄送**。
