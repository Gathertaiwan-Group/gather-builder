/** MCP／API 權限範圍。日後換 OAuth 2.1 時 scope 字串維持不變。 */
export const SCOPES = {
  "platform:sites": "平台級：建立網站、為網站發行 token（只能給平台 token）",
  "site:read": "讀取網站結構、頁面、區塊類型、版本、文章、作品",
  "content:write": "編輯頁面、區塊、導覽、文章與作品（只會進草稿）",
  "design:write": "修改主題",
  "modules:write": "啟用、停用、設定模組",
  publish: "預覽差異、發布草稿、還原版本",
  "inquiries:read": "讀取聯絡表單詢問",
} as const;

export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];
export const TENANT_SCOPES: Scope[] = ALL_SCOPES.filter((s) => s !== "platform:sites");

export function isScope(s: string): s is Scope {
  return Object.prototype.hasOwnProperty.call(SCOPES, s);
}
