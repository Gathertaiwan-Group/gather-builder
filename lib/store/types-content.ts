/**
 * 第五、六批（會員經營、內容與在地）的資料列與 Store 方法。
 * Supabase 實作在 supabase-content.ts、記憶體實作在 memory-content.ts（語意一致）。
 */

/* ------------------------------------------------------------------ 點數／儲值金帳本（只增不改） */

/** points＝builder_points_ledger；wallet＝builder_wallet_ledger */
export type CreditLedger = "points" | "wallet";

export interface CreditLedgerRow {
  id: string;
  tenant_id: string;
  member_id: string;
  /** points：earn／redeem／expire／reverse／adjust；wallet：topup／spend／refund／expire／reverse／adjust */
  kind: string;
  amount: number;
  expires_at: string | null;
  order_id: string | null;
  ref: string | null;
  reason: string | null;
  actor: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface CreditLedgerState {
  balance: number;
  available: number;
  expiredDue: number;
  nextExpiry: string | null;
}

export interface CreditPostInput {
  tenantId: string;
  memberId: string;
  kind: string;
  /** 正＝入帳、負＝扣帳 */
  amount: number;
  expiresAt?: string | null;
  /** 冪等鍵：同一個 ref 只會有一筆 */
  ref?: string | null;
  orderId?: string | null;
  reason?: string | null;
  actor?: string;
  meta?: Record<string, unknown>;
  /** credit 入帳／strict 扣帳（可用不足丟 ServiceError(conflict)）／capped 扣到可用為止（不足記 meta.shortfall） */
  mode: "credit" | "strict" | "capped";
}

export interface MemberTierRow {
  tenant_id: string;
  member_id: string;
  tier_id: string | null;
  spend: number;
  evaluated_at: string;
  changed_at: string;
}

export interface TopupPlanRow {
  id: string;
  tenant_id: string;
  name: string;
  /** 付多少錢（NT$，≥ 30） */
  pay_amount: number;
  /** 另外贈送的額度 */
  bonus_amount: number;
  /** 贈送額度幾天後到期（null＝不到期）；本金不到期 */
  bonus_expire_days: number | null;
  description: string | null;
  status: "draft" | "published";
  sort: number;
  created_at: string;
  updated_at: string;
}

/** i18n：模組資料（文章／商品／活動／課程）的翻譯 */
export type TrEntityType = "post" | "product" | "event" | "course";
export interface TranslationRow {
  id: string;
  tenant_id: string;
  entity_type: TrEntityType;
  entity_id: string;
  lang: string;
  field: string;
  draft_value: string | null;
  draft_ai: boolean;
  draft_updated_at: string | null;
  published_value: string | null;
  published_ai: boolean;
  published_at: string | null;
  updated_by: string | null;
}

/** 站內搜尋的原始命中（builder_search_content）；翻譯命中的 slug／title 為 null（由服務層補） */
export interface SearchHit {
  kind: string;
  id: string;
  slug: string | null;
  title: string | null;
  body: string | null;
  rank: number;
}

/** directory：人員名錄 */
export interface PersonRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  title: string | null;
  category: string | null;
  photo_url: string | null;
  bio_md: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  /** true 才在前台顯示 email／電話／網站 */
  show_contact: boolean;
  status: "draft" | "published";
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface ContentStore {
  // directory
  insertPerson(row: Omit<PersonRow, "id" | "created_at" | "updated_at">): Promise<PersonRow>;
  updatePerson(tenantId: string, id: string, patch: Partial<Omit<PersonRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<PersonRow | null>;
  getPersonById(tenantId: string, id: string): Promise<PersonRow | null>;
  getPersonBySlug(tenantId: string, slug: string): Promise<PersonRow | null>;
  listPeople(tenantId: string, opts: { status?: PersonRow["status"]; category?: string }): Promise<PersonRow[]>;

  // search（只搜該租戶、已發布；課程不搜單元內文）
  searchContent(tenantId: string, q: string, lang: string | null, limit: number): Promise<SearchHit[]>;

  // i18n
  upsertTranslationDrafts(rows: Pick<TranslationRow, "tenant_id" | "entity_type" | "entity_id" | "lang" | "field" | "draft_value" | "draft_ai" | "updated_by">[]): Promise<void>;
  listTranslations(tenantId: string, opts: { lang?: string; entityType?: TrEntityType; entityIds?: string[] }): Promise<TranslationRow[]>;
  /** 草稿 → 已發布（只動有草稿且與已發布不同的列），回傳筆數 */
  publishTranslationDrafts(tenantId: string, opts: { lang?: string; entityType?: TrEntityType; entityId?: string }, by: string): Promise<number>;

  // 儲值方案
  insertTopupPlan(row: Omit<TopupPlanRow, "id" | "created_at" | "updated_at">): Promise<TopupPlanRow>;
  updateTopupPlan(tenantId: string, id: string, patch: Partial<Omit<TopupPlanRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<TopupPlanRow | null>;
  getTopupPlan(tenantId: string, id: string): Promise<TopupPlanRow | null>;
  listTopupPlans(tenantId: string, opts: { status?: TopupPlanRow["status"] }): Promise<TopupPlanRow[]>;

  // 帳本（builder_ledger_post：每會員一把鎖、ref 冪等、先寫到期再處理本筆）
  creditPost(ledger: CreditLedger, input: CreditPostInput): Promise<{ posted: boolean; amount: number; balance: number }>;
  creditState(ledger: CreditLedger, tenantId: string, memberId: string): Promise<CreditLedgerState>;
  /** 新到舊 */
  listCreditLedger(ledger: CreditLedger, tenantId: string, memberId: string, limit: number): Promise<CreditLedgerRow[]>;
  /** 計算到期明細用：全部分錄（舊到新） */
  allCreditEntries(ledger: CreditLedger, tenantId: string, memberId: string): Promise<CreditLedgerRow[]>;
  getCreditByRef(ledger: CreditLedger, tenantId: string, ref: string): Promise<CreditLedgerRow | null>;
  /** cron：到期日落在 [fromIso, toIso) 的批次所屬會員（跨租戶） */
  listCreditMembersWithExpiry(ledger: CreditLedger, fromIso: string, toIso: string, limit: number): Promise<{ tenant_id: string; member_id: string }[]>;
  /** builder_ledger_expire：只寫到期，回傳到期點數 */
  creditExpire(ledger: CreditLedger, tenantId: string, memberId: string): Promise<number>;
  /** 期間內已付款消費（商品淨額，不含運費、儲值方案、sandbox） */
  memberSpend(tenantId: string, memberId: string, sinceIso: string | null): Promise<number>;
  getMemberTier(tenantId: string, memberId: string): Promise<MemberTierRow | null>;
  upsertMemberTier(row: Omit<MemberTierRow, "evaluated_at" | "changed_at"> & { changed?: boolean }): Promise<void>;
  listMemberTiers(tenantId: string, limit: number): Promise<MemberTierRow[]>;
}
