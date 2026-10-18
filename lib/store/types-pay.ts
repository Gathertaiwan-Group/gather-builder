/**
 * 第七批：退款與訂閱的資料列＋Store 方法（Supabase 與記憶體各自實作，同語意）。
 * 每個查詢都帶 tenant_id：A 站的資料在 B 站查不到。
 */
import type { ProviderId } from "../pay/types";

export interface RefundRow {
  id: string;
  tenant_id: string;
  order_id: string;
  payment_id: string;
  provider: ProviderId;
  amount: number;
  status: "requested" | "succeeded" | "failed" | "unknown";
  requested_by: string;
  reason: string | null;
  provider_refund_no: string | null;
  error: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type SubscriptionEntitlement = { kind: "none" } | { kind: "course"; courseId: string };

export interface SubscriptionPlanRow {
  id: string;
  tenant_id: string;
  name: string;
  amount: number;
  interval: "month" | "year";
  trial_days: number;
  total_periods: number;
  entitlement: SubscriptionEntitlement;
  provider: "newebpay";
  status: "draft" | "active" | "archived";
  description: string;
  created_at: string;
  updated_at: string;
}

export type SubscriptionStatus = "pending" | "active" | "past_due" | "cancelled" | "expired";

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  member_id: string;
  provider: "newebpay";
  sandbox: boolean;
  /** 短網址碼（/p/sn/<碼> 等；第七批審查 H2：定期定額網址上限 100 字） */
  short_code?: string | null;
  status: SubscriptionStatus;
  merchant_order_no: string;
  period_no: string | null;
  amount: number;
  interval: "month" | "year";
  total_periods: number;
  current_period_end: string | null;
  grace_until: string | null;
  failed_count: number;
  last_charge_at: string | null;
  cancel_state: "none" | "requested" | "done" | "failed";
  cancel_attempts: number;
  cancel_error: string | null;
  cancel_requested_at: string | null;
  entitlement_state: "none" | "granted" | "revoked";
  entitlement_ref: Record<string, unknown> | null;
  query_failures: number;
  alerted_at: string | null;
  activated_at: string | null;
  cancelled_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionChargeRow {
  id: number;
  tenant_id: string;
  subscription_id: string;
  period_index: number;
  amount: number;
  /** paid_after_end：委託在本站已結束／未記錄後仍被扣款（不恢復訂閱、不開權益，需人工退款） */
  status: "paid" | "failed" | "paid_after_end";
  trade_no: string | null;
  raw: Record<string, unknown> | null;
  created_at: string;
}

export type SubscriptionPatch = Partial<
  Pick<
    SubscriptionRow,
    | "period_no"
    | "current_period_end"
    | "grace_until"
    | "cancel_state"
    | "cancel_attempts"
    | "cancel_error"
    | "cancel_requested_at"
    | "entitlement_state"
    | "entitlement_ref"
    | "activated_at"
    | "cancelled_at"
    | "ended_at"
    | "query_failures"
    | "alerted_at"
  >
>;

export interface PayStore {
  // refunds
  /** 同一筆付款已有進行中／成功／不明的退款 → 丟 ServiceError(conflict)（只能退一次） */
  insertRefund(row: Pick<RefundRow, "tenant_id" | "order_id" | "payment_id" | "provider" | "amount" | "requested_by" | "reason">): Promise<RefundRow>;
  /** 條件式更新（目前狀態 = from 才寫）；回傳是否真的轉換 */
  transitionRefund(tenantId: string, id: string, from: RefundRow["status"], to: RefundRow["status"], patch: Partial<Pick<RefundRow, "provider_refund_no" | "error" | "raw">>): Promise<boolean>;
  listRefundsForOrder(tenantId: string, orderId: string): Promise<RefundRow[]>;
  getRefund(tenantId: string, id: string): Promise<RefundRow | null>;
  /** 跨租戶：requested 超過 olderThanIso 仍未有結果的退款（cron 用） */
  listStaleRefunds(olderThanIso: string, limit: number): Promise<RefundRow[]>;

  // subscription plans
  insertSubscriptionPlan(row: Omit<SubscriptionPlanRow, "id" | "created_at" | "updated_at">): Promise<SubscriptionPlanRow>;
  updateSubscriptionPlan(tenantId: string, id: string, patch: Partial<Pick<SubscriptionPlanRow, "name" | "status" | "description">>): Promise<SubscriptionPlanRow | null>;
  getSubscriptionPlan(tenantId: string, id: string): Promise<SubscriptionPlanRow | null>;
  listSubscriptionPlans(tenantId: string, opts: { status?: SubscriptionPlanRow["status"] }): Promise<SubscriptionPlanRow[]>;

  // subscriptions
  /** 同一會員同一方案已有進行中的訂閱 → 丟 ServiceError(conflict) */
  insertSubscription(row: Pick<SubscriptionRow, "tenant_id" | "plan_id" | "member_id" | "provider" | "sandbox" | "merchant_order_no" | "amount" | "interval" | "total_periods"> & Partial<Pick<SubscriptionRow, "short_code">>): Promise<SubscriptionRow>;
  getSubscriptionByShortCode(code: string): Promise<SubscriptionRow | null>;
  getSubscription(tenantId: string, id: string): Promise<SubscriptionRow | null>;
  getSubscriptionByMerchantOrderNo(merchantOrderNo: string): Promise<SubscriptionRow | null>;
  listSubscriptions(tenantId: string, opts: { status?: SubscriptionStatus; memberId?: string; planId?: string; limit: number; offset: number }): Promise<{ rows: SubscriptionRow[]; total: number }>;
  /** 跨租戶掃描（cron）：寬限到期、取消後到期、應扣未扣、終止委託待重試 */
  listSubscriptionsForSweep(nowIso: string, limit: number): Promise<SubscriptionRow[]>;
  /** 條件式狀態轉換（目前狀態 ∈ from 才寫）；沒轉換回 null */
  transitionSubscription(tenantId: string, id: string, from: SubscriptionStatus[], to: SubscriptionStatus, patch?: SubscriptionPatch): Promise<SubscriptionRow | null>;
  /** 不改狀態的欄位更新；where 可加條件（例如 entitlement_state = 'none' 才寫） */
  updateSubscriptionIf(tenantId: string, id: string, where: Partial<Pick<SubscriptionRow, "entitlement_state" | "cancel_state" | "status" | "alerted_at" | "period_no">>, patch: SubscriptionPatch): Promise<SubscriptionRow | null>;
  /** builder_record_subscription_charge：同一交易插入扣款（同期同結果只一次）＋轉換狀態 */
  recordSubscriptionCharge(
    tenantId: string,
    input: { subscriptionId: string; periodIndex: number; amount: number; status: "paid" | "failed" | "paid_after_end"; tradeNo: string | null; raw: Record<string, unknown> | null; periodEnd: string; graceUntil: string },
  ): Promise<{ inserted: boolean; status: SubscriptionStatus }>;
  listSubscriptionCharges(tenantId: string, subscriptionId: string): Promise<SubscriptionChargeRow[]>;
}
