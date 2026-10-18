import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { PayStore, RefundRow, SubscriptionChargeRow, SubscriptionPlanRow, SubscriptionRow } from "./types-pay";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 退款與訂閱的記憶體實作（與 0031／0032 的 SQL 同語意：唯一鍵、條件式轉換、builder_record_subscription_charge） */
export function createMemoryPayStore(): PayStore {
  const refunds = new Map<string, RefundRow>();
  const plans = new Map<string, SubscriptionPlanRow>();
  const subs = new Map<string, SubscriptionRow>();
  const charges: SubscriptionChargeRow[] = [];
  let chargeSeq = 0;
  const LIVE_REFUND = new Set<RefundRow["status"]>(["requested", "succeeded", "unknown"]);
  const LIVE_SUB = new Set<SubscriptionRow["status"]>(["pending", "active", "past_due"]);

  return {
    async insertRefund(row) {
      if ([...refunds.values()].some((r) => r.payment_id === row.payment_id && LIVE_REFUND.has(r.status))) throw new ServiceError("conflict", "資料重複");
      const r: RefundRow = { ...row, id: randomUUID(), status: "requested", provider_refund_no: null, error: null, raw: null, created_at: now(), updated_at: now() };
      refunds.set(r.id, r);
      return clone(r);
    },
    async transitionRefund(tenantId, id, from, to, patch) {
      const r = refunds.get(id);
      if (!r || r.tenant_id !== tenantId || r.status !== from) return false;
      refunds.set(id, { ...r, ...clone(patch), status: to, updated_at: now() });
      return true;
    },
    async listRefundsForOrder(tenantId, orderId) {
      return clone([...refunds.values()].filter((r) => r.tenant_id === tenantId && r.order_id === orderId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    },

    async insertSubscriptionPlan(row) {
      const p: SubscriptionPlanRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      plans.set(p.id, p);
      return clone(p);
    },
    async updateSubscriptionPlan(tenantId, id, patch) {
      const p = plans.get(id);
      if (!p || p.tenant_id !== tenantId) return null;
      const next = { ...p, ...clone(patch), updated_at: now() };
      plans.set(id, next);
      return clone(next);
    },
    async getSubscriptionPlan(tenantId, id) {
      const p = plans.get(id);
      return p && p.tenant_id === tenantId ? clone(p) : null;
    },
    async listSubscriptionPlans(tenantId, opts) {
      return clone([...plans.values()].filter((p) => p.tenant_id === tenantId && (!opts.status || p.status === opts.status)).sort((a, b) => a.amount - b.amount));
    },

    async insertSubscription(row) {
      if ([...subs.values()].some((s) => s.merchant_order_no === row.merchant_order_no)) throw new ServiceError("conflict", "資料重複");
      if ([...subs.values()].some((s) => s.tenant_id === row.tenant_id && s.plan_id === row.plan_id && s.member_id === row.member_id && LIVE_SUB.has(s.status))) throw new ServiceError("conflict", "資料重複");
      const s: SubscriptionRow = {
        ...clone(row),
        id: randomUUID(),
        status: "pending",
        period_no: null,
        current_period_end: null,
        grace_until: null,
        failed_count: 0,
        last_charge_at: null,
        cancel_state: "none",
        cancel_attempts: 0,
        cancel_error: null,
        cancel_requested_at: null,
        entitlement_state: "none",
        entitlement_ref: null,
        query_failures: 0,
        alerted_at: null,
        activated_at: null,
        cancelled_at: null,
        ended_at: null,
        created_at: now(),
        updated_at: now(),
      };
      subs.set(s.id, s);
      return clone(s);
    },
    async getSubscription(tenantId, id) {
      const s = subs.get(id);
      return s && s.tenant_id === tenantId ? clone(s) : null;
    },
    async getSubscriptionByMerchantOrderNo(no) {
      return clone([...subs.values()].find((s) => s.merchant_order_no === no) ?? null);
    },
    async listSubscriptions(tenantId, opts) {
      const all = [...subs.values()]
        .filter((s) => s.tenant_id === tenantId && (!opts.status || s.status === opts.status) && (!opts.memberId || s.member_id === opts.memberId) && (!opts.planId || s.plan_id === opts.planId))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: clone(all.slice(opts.offset, opts.offset + opts.limit)), total: all.length };
    },
    async listSubscriptionsForSweep(nowIso, limit) {
      return clone(
        [...subs.values()]
          .filter(
            (s) =>
              (s.status === "past_due" && !!s.grace_until && s.grace_until <= nowIso) ||
              (s.status === "active" && !!s.current_period_end && s.current_period_end <= nowIso) ||
              ((s.status === "cancelled" || s.status === "expired") && s.entitlement_state === "granted" && !!s.ended_at && s.ended_at <= nowIso) ||
              ((s.cancel_state === "requested" || s.cancel_state === "failed") && s.cancel_attempts < 10 && LIVE_SUB.has(s.status)) ||
              (s.status === "pending" && s.created_at <= new Date(Date.parse(nowIso) - 3600_000).toISOString()),
          )
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .slice(0, limit),
      );
    },
    async transitionSubscription(tenantId, id, from, to, patch = {}) {
      const s = subs.get(id);
      if (!s || s.tenant_id !== tenantId || !from.includes(s.status)) return null;
      const next = { ...s, ...clone(patch), status: to, updated_at: now() };
      subs.set(id, next);
      return clone(next);
    },
    async updateSubscriptionIf(tenantId, id, where, patch) {
      const s = subs.get(id);
      if (!s || s.tenant_id !== tenantId) return null;
      for (const [k, v] of Object.entries(where)) if ((s as unknown as Record<string, unknown>)[k] !== v) return null;
      const next = { ...s, ...clone(patch), updated_at: now() };
      subs.set(id, next);
      return clone(next);
    },
    async recordSubscriptionCharge(tenantId, input) {
      const s = subs.get(input.subscriptionId);
      if (!s || s.tenant_id !== tenantId) throw new Error("builder: subscription not found");
      if (charges.some((c) => c.subscription_id === s.id && c.period_index === input.periodIndex && c.status === input.status)) return { inserted: false, status: s.status };
      charges.push({ id: ++chargeSeq, tenant_id: tenantId, subscription_id: s.id, period_index: input.periodIndex, amount: input.amount, status: input.status, trade_no: input.tradeNo, raw: clone(input.raw), created_at: now() });
      let next = s;
      if (input.status === "paid" && LIVE_SUB.has(s.status)) {
        const end = !s.current_period_end || input.periodEnd > s.current_period_end ? input.periodEnd : s.current_period_end;
        next = { ...s, status: "active", current_period_end: end, grace_until: null, failed_count: 0, last_charge_at: now(), activated_at: s.activated_at ?? now(), updated_at: now() };
      } else if (input.status === "failed" && (s.status === "active" || s.status === "past_due") && !charges.some((c) => c.subscription_id === s.id && c.status === "paid" && c.period_index >= input.periodIndex)) {
        next = { ...s, status: "past_due", grace_until: s.grace_until ?? input.graceUntil, failed_count: s.failed_count + 1, updated_at: now() };
      }
      subs.set(s.id, next);
      return { inserted: true, status: next.status };
    },
    async listSubscriptionCharges(tenantId, subscriptionId) {
      return clone(charges.filter((c) => c.tenant_id === tenantId && c.subscription_id === subscriptionId).sort((a, b) => a.period_index - b.period_index || a.id - b.id));
    },
  };
}
