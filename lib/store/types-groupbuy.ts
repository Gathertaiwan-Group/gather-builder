import type { OrderRow } from "./types";

/* ------------------------------------------------------------------ group-buy（團購，第八批） */

export type GroupBuyStatus = "draft" | "published" | "closed" | "failed" | "cancelled";

export interface PickupPoint {
  /** 自取點代號（小寫英數、- _） */
  id: string;
  name: string;
  address: string;
  hours?: string | null;
}

export interface GroupBuyRow {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  description_md: string;
  cover_url: string | null;
  status: GroupBuyStatus;
  starts_at: string | null;
  ends_at: string;
  /** 成團門檻（總件數）；null＝不設門檻 */
  min_qty: number | null;
  pickup_points: PickupPoint[];
  /** 允許的 shipping 模組運送方式 id（null＝全部） */
  shipping_method_ids: string[] | null;
  closed_at: string | null;
  settled_at: string | null;
  copied_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupBuyItemRow {
  id: string;
  tenant_id: string;
  group_buy_id: string;
  product_id: string;
  variant_id: string | null;
  /** 團購價（server 端計價只用這個） */
  price: number;
  /** 限量（null＝不限）；sold 原子累加，DB check sold ≤ quota */
  quota: number | null;
  sold: number;
  sort: number;
  created_at: string;
}

export interface GroupBuyItemWrite {
  product_id: string;
  variant_id: string | null;
  price: number;
  quota: number | null;
  sort: number;
}

export interface GroupBuyLeaderRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  email_norm: string;
  /** 團購連結參數 ?leader=<code>（8 碼） */
  code: string;
  status: "active" | "disabled";
  /** 報表簽章連結版本（+1＝舊連結失效） */
  report_version: number;
  created_at: string;
  updated_at: string;
}

export type CommissionKind = "percent" | "fixed";

export interface LeaderAssignmentRow {
  id: string;
  tenant_id: string;
  group_buy_id: string;
  leader_id: string;
  /** percent：commission_value 為萬分比（1000＝10%）；fixed：每張訂單 NT$ */
  commission_kind: CommissionKind;
  commission_value: number;
  active: boolean;
  created_at: string;
}

export interface GroupBuyOrderLine {
  item_id: string;
  qty: number;
  name: string;
}

/** 團購單的延伸資料（主表 builder_orders 另有 group_buy_id／group_buy_leader_id） */
export interface GroupBuyOrderRow {
  order_id: string;
  tenant_id: string;
  group_buy_id: string;
  leader_id: string | null;
  lines: GroupBuyOrderLine[];
  payer_last5: string | null;
  commission_kind: CommissionKind | null;
  commission_value: number | null;
  quota_released_at: string | null;
  created_at: string;
}

/** 下單時帶進 placeOrder 的團購資料（在 builder_place_group_buy_order 同一交易原子扣限量） */
export interface GroupBuyOrderInput {
  group_buy_id: string;
  leader_id: string | null;
  lines: GroupBuyOrderLine[];
  payer_last5: string | null;
  commission_kind: CommissionKind | null;
  commission_value: number | null;
}

export interface GroupBuyCommissionRow {
  id: number;
  tenant_id: string;
  group_buy_id: string;
  leader_id: string;
  order_id: string;
  kind: "earn" | "reverse";
  amount: number;
  base: number;
  created_at: string;
}

export interface BankImportRow {
  id: string;
  tenant_id: string;
  filename: string | null;
  row_count: number;
  inserted_count: number;
  created_by: string;
  created_at: string;
}

export type BankLineStatus = "unmatched" | "suggested" | "ambiguous" | "confirmed" | "ignored";

export interface BankLineRow {
  id: string;
  tenant_id: string;
  import_id: string;
  /** YYYY-MM-DD */
  txn_date: string;
  amount: number;
  last5: string | null;
  memo: string | null;
  fingerprint: string;
  status: BankLineStatus;
  created_at: string;
}

export type BankMatchStatus = "suggested" | "confirmed" | "rejected";

export interface BankMatchRow {
  id: string;
  tenant_id: string;
  line_id: string;
  order_id: string;
  status: BankMatchStatus;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface GroupBuyStore {
  /** slug 重複丟 ServiceError(conflict) */
  insertGroupBuy(row: Omit<GroupBuyRow, "id" | "created_at" | "updated_at" | "closed_at" | "settled_at">): Promise<GroupBuyRow>;
  updateGroupBuy(tenantId: string, id: string, patch: Partial<Omit<GroupBuyRow, "id" | "tenant_id" | "created_at" | "updated_at">>): Promise<GroupBuyRow | null>;
  /** 條件式轉換：目前狀態在 from 裡才更新；沒轉換回 null */
  transitionGroupBuy(tenantId: string, id: string, from: GroupBuyStatus[], to: GroupBuyStatus, patch: Partial<Pick<GroupBuyRow, "closed_at" | "ends_at" | "settled_at">>): Promise<GroupBuyRow | null>;
  /** 結團處理完成（settled_at 由 null 改成 now 的那一次回 true） */
  markGroupBuySettled(tenantId: string, id: string): Promise<boolean>;
  getGroupBuy(tenantId: string, id: string): Promise<GroupBuyRow | null>;
  getGroupBuyBySlug(tenantId: string, slug: string): Promise<GroupBuyRow | null>;
  listGroupBuys(tenantId: string, opts: { status?: GroupBuyStatus[]; limit: number }): Promise<GroupBuyRow[]>;
  /** 所有租戶：已到截止的開團中＋已結團但還沒處理完的（cron 用） */
  listDueGroupBuys(nowIso: string, limit: number): Promise<Pick<GroupBuyRow, "id" | "tenant_id">[]>;
  /**
   * 整份取代品項（patch 語意，依 product＋variant 比對沿用原列）：改價格／限量／排序；新的新增；
   * 移除或把限量改到低於已售 → ServiceError(conflict)。
   */
  replaceGroupBuyItems(tenantId: string, groupBuyId: string, rows: GroupBuyItemWrite[]): Promise<GroupBuyItemRow[]>;
  listGroupBuyItems(tenantId: string, groupBuyId: string): Promise<GroupBuyItemRow[]>;

  /** (tenant, code) 或 (tenant, email_norm) 重複回 null */
  insertLeader(row: Pick<GroupBuyLeaderRow, "tenant_id" | "name" | "email" | "email_norm" | "code">): Promise<GroupBuyLeaderRow | null>;
  getLeader(tenantId: string, id: string): Promise<GroupBuyLeaderRow | null>;
  getLeaderByCode(tenantId: string, code: string): Promise<GroupBuyLeaderRow | null>;
  getLeaderByEmail(tenantId: string, emailNorm: string): Promise<GroupBuyLeaderRow | null>;
  updateLeader(tenantId: string, id: string, patch: Partial<Pick<GroupBuyLeaderRow, "name" | "status" | "report_version">>): Promise<GroupBuyLeaderRow | null>;
  listLeaders(tenantId: string): Promise<GroupBuyLeaderRow[]>;
  upsertLeaderAssignment(row: Pick<LeaderAssignmentRow, "tenant_id" | "group_buy_id" | "leader_id" | "commission_kind" | "commission_value" | "active">): Promise<LeaderAssignmentRow>;
  listLeaderAssignments(tenantId: string, opts: { groupBuyId?: string; leaderId?: string }): Promise<LeaderAssignmentRow[]>;

  getGroupBuyOrder(tenantId: string, orderId: string): Promise<GroupBuyOrderRow | null>;
  /** 客人回報匯款帳號末五碼（只在訂單仍待付款時由呼叫端允許） */
  setGroupBuyPayerLast5(tenantId: string, orderId: string, last5: string): Promise<boolean>;
  listGroupBuyOrderRows(tenantId: string, opts: { groupBuyId?: string; leaderId?: string; orderIds?: string[] }): Promise<GroupBuyOrderRow[]>;
  /** 只增不改：unique(order_id, kind)，已存在回 false */
  insertGroupBuyCommission(row: Omit<GroupBuyCommissionRow, "id" | "created_at">): Promise<boolean>;
  listGroupBuyCommissions(tenantId: string, opts: { orderIds?: string[]; leaderId?: string; groupBuyId?: string }): Promise<GroupBuyCommissionRow[]>;
  /** 只增不改：unique(group_buy, order, kind)，第一次回 true（＝這次要寄） */
  insertGroupBuyNotice(row: { tenant_id: string; group_buy_id: string; order_id: string; kind: "formed" | "failed" }): Promise<boolean>;

  insertBankImport(row: Pick<BankImportRow, "tenant_id" | "filename" | "row_count" | "created_by">): Promise<BankImportRow>;
  setBankImportInserted(tenantId: string, id: string, inserted: number): Promise<void>;
  /** fingerprint 重複的列略過；回傳實際新增的列 */
  insertBankLines(rows: Omit<BankLineRow, "id" | "created_at" | "status">[]): Promise<BankLineRow[]>;
  listBankLines(tenantId: string, opts: { status?: BankLineStatus[]; ids?: string[]; limit: number }): Promise<BankLineRow[]>;
  setBankLineStatus(tenantId: string, ids: string[], status: BankLineStatus): Promise<void>;
  /** partial unique（明細／訂單各只能有一筆有效配對）衝突回 null */
  insertBankMatch(row: Pick<BankMatchRow, "tenant_id" | "line_id" | "order_id">): Promise<BankMatchRow | null>;
  listBankMatches(tenantId: string, opts: { status?: BankMatchStatus[]; ids?: string[]; limit: number }): Promise<BankMatchRow[]>;
  /** 條件式：目前狀態 = from 才改；回傳是否真的改了 */
  decideBankMatch(tenantId: string, id: string, from: BankMatchStatus, to: BankMatchStatus, patch: { reason?: string | null; decided_by: string }): Promise<boolean>;
  /**
   * 單一交易（builder_confirm_bank_match）：配對 suggested → confirmed ＋ 訂單 pending_payment → paid（只限線下匯款）。
   * 配對不是 suggested 回 null；訂單不能收款丟 ServiceError(conflict)（整筆回滾，配對維持 suggested）。
   */
  confirmBankMatch(tenantId: string, matchId: string, by: string): Promise<OrderRow | null>;
}
