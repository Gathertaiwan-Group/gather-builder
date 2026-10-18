import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import { computeLedgerState } from "../loyalty/ledger";
import { CREDIT_ERRORS } from "./supabase-content";
import type { ContentStore, CreditLedger, CreditLedgerRow, CreditPostInput, MemberTierRow, TopupPlanRow } from "./types-content";
import type { OrderCreditsInput, OrderRow, Store } from "./types";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/**
 * 下單／取消時的點數與儲值金（＝SQL builder_apply_order_credits／builder_release_order_credits）。
 * checkSync 在寫入任何東西之前檢查（不足就丟錯），postSync 在同一個同步區段寫入——JS 單執行緒，等同 DB 交易。
 */
export interface CreditsBridge {
  checkSync(tenantId: string, memberId: string | null, input: OrderCreditsInput): void;
  postSync(tenantId: string, orderId: string, memberId: string | null, input: OrderCreditsInput): void;
  releaseSync(tenantId: string, order: Pick<OrderRow, "id" | "member_id" | "points_redeemed" | "wallet_paid">): void;
}

export function createMemoryContentStore(): { store: ContentStore; credits: CreditsBridge; attach(s: Store): void } {
  const ledgers: Record<CreditLedger, (CreditLedgerRow & { seq: number })[]> = { points: [], wallet: [] };
  const tiers = new Map<string, MemberTierRow>();
  let seq = 0;
  let root: Store | null = null;
  /** 與 SQL 版本對齊（0022 起支援儲值金扣款） */
  const walletEnabled = true;
  const plans = new Map<string, TopupPlanRow>();

  const entries = (l: CreditLedger, tenantId: string, memberId: string) => ledgers[l].filter((e) => e.tenant_id === tenantId && e.member_id === memberId);
  const state = (l: CreditLedger, tenantId: string, memberId: string) => computeLedgerState(entries(l, tenantId, memberId));
  const insert = (l: CreditLedger, row: Omit<CreditLedgerRow, "id" | "created_at">) => {
    const r = { ...row, id: randomUUID(), created_at: now(), seq: ++seq };
    ledgers[l].push(r);
    return r;
  };
  const insufficient = (l: CreditLedger) => new ServiceError("conflict", CREDIT_ERRORS[l === "points" ? "points insufficient" : "wallet insufficient"]!);

  /** 同 builder_ledger_post（同步） */
  function postSync(l: CreditLedger, i: CreditPostInput) {
    if (!i.amount) throw new Error("builder: bad amount");
    if (i.ref) {
      const ex = ledgers[l].find((e) => e.tenant_id === i.tenantId && e.ref === i.ref);
      if (ex) return { posted: false, amount: ex.amount, balance: state(l, i.tenantId, i.memberId).balance };
    }
    let st = state(l, i.tenantId, i.memberId);
    if (st.expiredDue > 0) {
      insert(l, { tenant_id: i.tenantId, member_id: i.memberId, kind: "expire", amount: -st.expiredDue, expires_at: null, order_id: null, ref: null, reason: "到期", actor: "system", meta: {} });
      st = state(l, i.tenantId, i.memberId);
    }
    let amount = i.amount;
    let meta = { ...(i.meta ?? {}) };
    if (i.mode === "credit") {
      if (amount < 0) throw new Error("builder: bad amount");
    } else if (i.mode === "strict") {
      if (amount > 0) throw new Error("builder: bad amount");
      if (st.available < -amount) throw insufficient(l);
    } else {
      if (amount > 0) throw new Error("builder: bad amount");
      if (st.available < -amount) {
        meta = { ...meta, requested: -amount, shortfall: -amount - st.available };
        amount = -st.available;
      }
      if (amount === 0) return { posted: false, amount: 0, balance: st.balance };
    }
    insert(l, { tenant_id: i.tenantId, member_id: i.memberId, kind: i.kind, amount, expires_at: i.expiresAt ?? null, order_id: i.orderId ?? null, ref: i.ref ?? null, reason: i.reason ?? null, actor: i.actor ?? "system", meta });
    return { posted: true, amount, balance: state(l, i.tenantId, i.memberId).balance };
  }

  const credits: CreditsBridge = {
    checkSync(tenantId, memberId, input) {
      const pts = input.points_redeemed ?? 0;
      const wal = input.wallet_paid ?? 0;
      if ((pts > 0 || wal > 0) && !memberId) throw new ServiceError("conflict", CREDIT_ERRORS["credits need member"]!);
      if (pts > 0 && state("points", tenantId, memberId!).available < pts) throw insufficient("points");
      if (wal > 0 && !walletEnabled) throw new ServiceError("conflict", CREDIT_ERRORS["wallet unavailable"]!);
      if (wal > 0 && state("wallet", tenantId, memberId!).available < wal) throw insufficient("wallet");
    },
    postSync(tenantId, orderId, memberId, input) {
      const pts = input.points_redeemed ?? 0;
      const wal = input.wallet_paid ?? 0;
      if (pts > 0) postSync("points", { tenantId, memberId: memberId!, kind: "redeem", amount: -pts, ref: `order:${orderId}:redeem`, orderId, reason: "訂單折抵", actor: "checkout", mode: "strict" });
      if (wal > 0) postSync("wallet", { tenantId, memberId: memberId!, kind: "spend", amount: -wal, ref: `order:${orderId}:spend`, orderId, reason: "訂單支付", actor: "checkout", mode: "strict" });
    },
    releaseSync(tenantId, order) {
      if (!order.member_id) return;
      const has = (l: CreditLedger, ref: string) => ledgers[l].some((e) => e.tenant_id === tenantId && e.ref === ref);
      if ((order.points_redeemed ?? 0) > 0 && has("points", `order:${order.id}:redeem`)) {
        postSync("points", { tenantId, memberId: order.member_id, kind: "reverse", amount: order.points_redeemed!, ref: `order:${order.id}:redeem_refund`, orderId: order.id, reason: "訂單取消，退回折抵點數", mode: "credit" });
      }
      if ((order.wallet_paid ?? 0) > 0 && has("wallet", `order:${order.id}:spend`)) {
        postSync("wallet", { tenantId, memberId: order.member_id, kind: "refund", amount: order.wallet_paid!, ref: `order:${order.id}:spend_refund`, orderId: order.id, reason: "訂單取消，退回儲值金", mode: "credit" });
      }
    },
  };

  const store: ContentStore = {
    async insertTopupPlan(row) {
      const r: TopupPlanRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      plans.set(r.id, r);
      return clone(r);
    },
    async updateTopupPlan(tenantId, id, patch) {
      const p = plans.get(id);
      if (!p || p.tenant_id !== tenantId) return null;
      const next = { ...p, ...clone(patch), updated_at: now() };
      plans.set(id, next);
      return clone(next);
    },
    async getTopupPlan(tenantId, id) {
      const p = plans.get(id);
      return p && p.tenant_id === tenantId ? clone(p) : null;
    },
    async listTopupPlans(tenantId, opts) {
      return clone([...plans.values()].filter((p) => p.tenant_id === tenantId && (!opts.status || p.status === opts.status)).sort((a, b) => a.sort - b.sort || a.pay_amount - b.pay_amount));
    },
    async creditPost(l, i) {
      return postSync(l, i);
    },
    async creditState(l, tenantId, memberId) {
      const s = state(l, tenantId, memberId);
      return { balance: s.balance, available: s.available, expiredDue: s.expiredDue, nextExpiry: s.nextExpiry };
    },
    async listCreditLedger(l, tenantId, memberId, limit) {
      return clone(entries(l, tenantId, memberId).slice().reverse().slice(0, limit)).map(({ seq: _s, ...r }) => r);
    },
    async allCreditEntries(l, tenantId, memberId) {
      return clone(entries(l, tenantId, memberId)).map(({ seq: _s, ...r }) => r);
    },
    async getCreditByRef(l, tenantId, ref) {
      const r = ledgers[l].find((e) => e.tenant_id === tenantId && e.ref === ref);
      if (!r) return null;
      const { seq: _s, ...rest } = clone(r);
      return rest;
    },
    async listCreditMembersWithExpiry(l, fromIso, toIso, limit) {
      const seen = new Set<string>();
      const out: { tenant_id: string; member_id: string }[] = [];
      for (const e of ledgers[l]) {
        if (e.amount <= 0 || !e.expires_at || e.expires_at < fromIso || e.expires_at >= toIso) continue;
        const k = `${e.tenant_id}|${e.member_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ tenant_id: e.tenant_id, member_id: e.member_id });
      }
      return out.slice(0, limit);
    },
    async creditExpire(l, tenantId, memberId) {
      const s = state(l, tenantId, memberId);
      if (s.expiredDue <= 0) return 0;
      insert(l, { tenant_id: tenantId, member_id: memberId, kind: "expire", amount: -s.expiredDue, expires_at: null, order_id: null, ref: null, reason: "到期", actor: "system", meta: {} });
      return s.expiredDue;
    },
    async memberSpend(tenantId, memberId, sinceIso) {
      if (!root) return 0;
      const all = (await root.listOrders(tenantId, { memberId, limit: 100000, offset: 0 })).rows;
      return all
        .filter((o) => (o.status === "paid" || o.status === "fulfilled") && !o.payment_sandbox && (!sinceIso || (o.paid_at ?? "") >= sinceIso))
        .filter((o) => !o.items.some((i) => (i as { item_kind?: string }).item_kind === "topup"))
        .reduce((n, o) => n + Math.max(0, o.subtotal - (o.discount_total ?? 0) - (o.tier_discount ?? 0) - (o.points_discount ?? 0)), 0);
    },
    async getMemberTier(tenantId, memberId) {
      return clone(tiers.get(`${tenantId}|${memberId}`) ?? null);
    },
    async upsertMemberTier(row) {
      const k = `${row.tenant_id}|${row.member_id}`;
      const cur = tiers.get(k);
      const { changed, ...rest } = row;
      tiers.set(k, { ...rest, evaluated_at: now(), changed_at: changed || !cur ? now() : cur.changed_at });
    },
    async listMemberTiers(tenantId, limit) {
      return clone([...tiers.values()].filter((t) => t.tenant_id === tenantId).slice(0, limit));
    },
  };
  return {
    store,
    credits,
    attach(s: Store) {
      root = s;
    },
  };
}
