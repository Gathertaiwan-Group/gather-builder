import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { PayStore, RefundRow, SubscriptionChargeRow, SubscriptionPlanRow, SubscriptionRow, SubscriptionStatus } from "./types-pay";

const nowIso = () => new Date().toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function must<T>(r: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data;
}

/** 退款與訂閱（public.builder_refunds／builder_subscription_*；0031／0032） */
export function createSupabasePayStore(db: SupabaseClient): PayStore {
  return {
    async insertRefund(row) {
      return must(await db.from("builder_refunds").insert(row).select("*").single(), "insertRefund") as RefundRow;
    },
    async transitionRefund(tenantId, id, from, to, patch) {
      const rows = must(await db.from("builder_refunds").update({ ...patch, status: to, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).eq("status", from).select("id"), "transitionRefund") as { id: string }[];
      return rows.length > 0;
    },
    async listRefundsForOrder(tenantId, orderId) {
      return (must(await db.from("builder_refunds").select("*").eq("tenant_id", tenantId).eq("order_id", orderId).order("created_at"), "listRefundsForOrder") ?? []) as RefundRow[];
    },

    async insertSubscriptionPlan(row) {
      return must(await db.from("builder_subscription_plans").insert(row).select("*").single(), "insertSubscriptionPlan") as SubscriptionPlanRow;
    },
    async updateSubscriptionPlan(tenantId, id, patch) {
      if (!UUID.test(id)) return null;
      return must(await db.from("builder_subscription_plans").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateSubscriptionPlan") as SubscriptionPlanRow | null;
    },
    async getSubscriptionPlan(tenantId, id) {
      if (!UUID.test(id)) return null;
      return must(await db.from("builder_subscription_plans").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getSubscriptionPlan") as SubscriptionPlanRow | null;
    },
    async listSubscriptionPlans(tenantId, opts) {
      let q = db.from("builder_subscription_plans").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return (must(await q.order("amount"), "listSubscriptionPlans") ?? []) as SubscriptionPlanRow[];
    },

    async insertSubscription(row) {
      return must(await db.from("builder_subscriptions").insert(row).select("*").single(), "insertSubscription") as SubscriptionRow;
    },
    async getSubscription(tenantId, id) {
      if (!UUID.test(id)) return null;
      return must(await db.from("builder_subscriptions").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getSubscription") as SubscriptionRow | null;
    },
    async getSubscriptionByMerchantOrderNo(no) {
      return must(await db.from("builder_subscriptions").select("*").eq("merchant_order_no", no).maybeSingle(), "getSubscriptionByMerchantOrderNo") as SubscriptionRow | null;
    },
    async listSubscriptions(tenantId, opts) {
      let q = db.from("builder_subscriptions").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.memberId) q = q.eq("member_id", opts.memberId);
      if (opts.planId) q = q.eq("plan_id", opts.planId);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      return { rows: (must(r, "listSubscriptions") ?? []) as SubscriptionRow[], total: r.count ?? 0 };
    },
    async listSubscriptionsForSweep(now, limit) {
      const hourAgo = new Date(Date.parse(now) - 3600_000).toISOString();
      const filter = [
        `and(status.eq.past_due,grace_until.lte.${now})`,
        `and(status.eq.active,current_period_end.lte.${now})`,
        `and(status.in.(cancelled,expired),entitlement_state.eq.granted,ended_at.lte.${now})`,
        `and(cancel_state.in.(requested,failed),cancel_attempts.lt.10,status.in.(pending,active,past_due))`,
        `and(status.eq.pending,created_at.lte.${hourAgo})`,
      ].join(",");
      return (must(await db.from("builder_subscriptions").select("*").or(filter).order("updated_at").limit(limit), "listSubscriptionsForSweep") ?? []) as SubscriptionRow[];
    },
    async transitionSubscription(tenantId, id, from, to, patch = {}) {
      return must(
        await db.from("builder_subscriptions").update({ ...patch, status: to, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from).select("*").maybeSingle(),
        "transitionSubscription",
      ) as SubscriptionRow | null;
    },
    async updateSubscriptionIf(tenantId, id, where, patch) {
      let q = db.from("builder_subscriptions").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id);
      for (const [k, v] of Object.entries(where)) q = v === null ? q.is(k, null) : q.eq(k, v as string);
      return must(await q.select("*").maybeSingle(), "updateSubscriptionIf") as SubscriptionRow | null;
    },
    async recordSubscriptionCharge(tenantId, i) {
      const r = await db.rpc("builder_record_subscription_charge", {
        p_tenant: tenantId,
        p_sub: i.subscriptionId,
        p_period: i.periodIndex,
        p_amount: i.amount,
        p_status: i.status,
        p_trade_no: i.tradeNo,
        p_raw: i.raw,
        p_period_end: i.periodEnd,
        p_grace_until: i.graceUntil,
      });
      if (r.error) throw new Error(`recordSubscriptionCharge: ${r.error.message}`);
      const row = (r.data as { inserted: boolean; sub_status: SubscriptionStatus }[])[0]!;
      return { inserted: row.inserted, status: row.sub_status };
    },
    async listSubscriptionCharges(tenantId, subscriptionId) {
      return (must(await db.from("builder_subscription_charges").select("*").eq("tenant_id", tenantId).eq("subscription_id", subscriptionId).order("period_index").order("id"), "listSubscriptionCharges") ?? []) as SubscriptionChargeRow[];
    },
  };
}
