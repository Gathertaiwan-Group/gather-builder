import type { z } from "zod";

/** 模組分類（平台首頁的目錄分組用） */
export type ModuleCategory = "foundation" | "content" | "engagement" | "commerce";

export interface SectionTypeDef {
  /** 區塊類型 id，全平台唯一，例如 "hero" */
  type: string;
  /** 給人與 agent 看的名稱 */
  label: string;
  /** 何時用這個區塊（agent 會讀） */
  description: string;
  /** props 的 zod schema（server 端驗證的唯一依據） */
  schema: z.ZodType<Record<string, unknown>>;
  /** 新增時若沒給 props，用這組當起點 */
  example: Record<string, unknown>;
}

export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
  category: ModuleCategory;
  /** 一次性建置費（新台幣） */
  priceSetup: number;
  /** 月費（新台幣） */
  priceMonthly: number;
  /** 依賴的模組 id，開啟時自動帶入 */
  requires: string[];
  /** 模組設定的 zod schema；不通過時模組狀態為 pending_setup */
  settingsSchema: z.ZodType<Record<string, unknown>>;
  /** 本模組提供的區塊類型 */
  sectionTypes: SectionTypeDef[];
  /** 後台頁面（第一版僅宣告用） */
  adminPages?: { path: string; label: string }[];
  /** 本模組帶來的 MCP 工具名稱（宣告用，實作在 app/api/mcp） */
  mcpTools: string[];
  /** 不可停用（core） */
  locked?: boolean;
}
