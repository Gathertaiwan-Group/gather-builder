/** MCP／API 權限範圍。日後換 OAuth 2.1 時 scope 字串維持不變。 */
export const SCOPES = {
  "platform:sites": "平台級：建立網站、為網站發行 token（只能給平台 token）",
  "site:read": "讀取網站結構、頁面、區塊類型、版本、文章、作品",
  "content:write": "編輯頁面、區塊、導覽、文章與作品（只會進草稿）",
  "design:write": "修改主題",
  "modules:write": "啟用、停用、設定模組",
  publish: "預覽差異、發布草稿、還原版本",
  "inquiries:read": "讀取聯絡表單詢問",
  "members:read": "讀取會員列表與會員資料（不含密碼雜湊）",
  "members:write": "停用會員（需 confirm）",
  "commerce:write": "建立與修改商品（上架／修改已上架商品另需 publish ＋ confirm）",
  "orders:read": "讀取訂單（含收件個資）與金流設定狀態",
  "orders:write": "標記已收款、出貨、取消訂單（都需 confirm）",
  "invoices:write": "開立、重試、作廢／折讓電子發票（都需 confirm；讀取用 orders:read）",
  "shipping:write": "建立出貨單（綠界物流或手動出貨，需 confirm；讀取用 orders:read）",
  "marketing:write": "建立／停用優惠券、設定推薦 KOL 分潤",
  "newsletter:read": "讀取電子報訂閱者（個資）與群發紀錄",
  "newsletter:write": "建立電子報草稿、寄測試信、群發（群發需 confirm）",
  "classes:write": "活動／場次／票種、預約服務與營業時間、線上課程與單元（上架或改已上架項目另需 publish ＋ confirm；取消場次需 confirm）",
  "attendees:read": "讀取報名名單、預約、課程學員（個資遮罩；查看完整資料會留紀錄）",
  "attendees:write": "簽到、取消預約、手動開通／撤銷課程（都需 confirm）",
  "certificates:read": "讀取證照資料與查詢紀錄（姓名遮罩、不含生日）",
  "certificates:write": "匯入證照 CSV、變更證照狀態（都需 confirm）",
  "reviews:write": "審核（公開／隱藏）與回覆商品評價（都需 confirm）",
  "points:adjust": "手動加／扣會員點數（需 confirm＋理由；受單次與每日上限；members:write 不再能調整）",
  "wallet:adjust": "手動加／扣會員儲值金（需 confirm＋理由；受單次與每日上限；members:write 不再能調整）",
} as const;

export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];
export const TENANT_SCOPES: Scope[] = ALL_SCOPES.filter((s) => s !== "platform:sites");

export function isScope(s: string): s is Scope {
  return Object.prototype.hasOwnProperty.call(SCOPES, s);
}
