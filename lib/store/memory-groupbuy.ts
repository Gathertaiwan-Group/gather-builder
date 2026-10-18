import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import { GB_CLOSED, gbItemKey, gbQuotaMessage } from "./supabase-groupbuy";
import type {
  BankImportRow,
  BankLineRow,
  BankMatchRow,
  GroupBuyCommissionRow,
  GroupBuyItemRow,
  GroupBuyLeaderRow,
  GroupBuyOrderInput,
  GroupBuyOrderRow,
  GroupBuyRow,
  GroupBuyStore,
  LeaderAssignmentRow,
} from "./types-groupbuy";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/**
 * 記憶體 commerce store 用的橋接（＝builder_place_group_buy_order／builder_release_group_buy_quota／builder_confirm_bank_match 在同一交易做的事）：
 * 全部是同步函式，由 memory-commerce 在下單／取消／確認配對的同一個同步區段呼叫。
 */
export interface GroupBuyBridge {
  /** 檢查（不寫）：團購開放中、每個品項限量足夠；不足丟 ServiceError(conflict)（與 SQL 同一句話） */
  checkSync(tenantId: string, gb: GroupBuyOrderInput): void;
  /** 寫入：扣限量＋延伸資料 */
  applySync(tenantId: string, orderId: string, gb: GroupBuyOrderInput): void;
  /** 冪等釋放限量 */
  releaseSync(tenantId: string, orderId: string): boolean;
  /** 配對仍是 suggested → 回 order_id（不寫） */
  peekMatchSync(tenantId: string, matchId: string): { orderId: string; lineId: string } | null;
  commitMatchSync(tenantId: string, matchId: string, by: string): void;
}

export function createMemoryGroupBuyStore(): { store: Omit<GroupBuyStore, "confirmBankMatch">; bridge: GroupBuyBridge } {
  const gbs = new Map<string, GroupBuyRow>();
  const items = new Map<string, GroupBuyItemRow>();
  const leaders = new Map<string, GroupBuyLeaderRow>();
  const assignments = new Map<string, LeaderAssignmentRow>();
  const gbOrders = new Map<string, GroupBuyOrderRow>();
  const commissions: GroupBuyCommissionRow[] = [];
  const notices = new Set<string>();
  const imports = new Map<string, BankImportRow>();
  const lines = new Map<string, BankLineRow>();
  const matches = new Map<string, BankMatchRow>();
  let seq = 0;

  const activeMatch = (pred: (m: BankMatchRow) => boolean) => [...matches.values()].some((m) => (m.status === "suggested" || m.status === "confirmed") && pred(m));

  const bridge: GroupBuyBridge = {
    checkSync(tenantId, gb) {
      const g = gbs.get(gb.group_buy_id);
      const t = Date.now();
      if (!g || g.tenant_id !== tenantId || g.status !== "published" || (g.starts_at && new Date(g.starts_at).getTime() > t) || new Date(g.ends_at).getTime() <= t || !gb.lines.length) {
        throw new ServiceError("conflict", GB_CLOSED);
      }
      const need = new Map<string, number>();
      for (const l of gb.lines) need.set(l.item_id, (need.get(l.item_id) ?? 0) + l.qty);
      for (const l of gb.lines) {
        const it = items.get(l.item_id);
        if (!it || it.tenant_id !== tenantId || it.group_buy_id !== g.id || (it.quota !== null && it.sold + need.get(l.item_id)! > it.quota)) throw new ServiceError("conflict", gbQuotaMessage(l.name));
      }
    },
    applySync(tenantId, orderId, gb) {
      for (const l of gb.lines) {
        const it = items.get(l.item_id)!;
        items.set(it.id, { ...it, sold: it.sold + l.qty });
      }
      gbOrders.set(orderId, {
        order_id: orderId,
        tenant_id: tenantId,
        group_buy_id: gb.group_buy_id,
        leader_id: gb.leader_id,
        lines: clone(gb.lines),
        payer_last5: gb.payer_last5,
        commission_kind: gb.commission_kind,
        commission_value: gb.commission_value,
        quota_released_at: null,
        created_at: now(),
      });
    },
    releaseSync(tenantId, orderId) {
      const o = gbOrders.get(orderId);
      if (!o || o.tenant_id !== tenantId || o.quota_released_at) return false;
      gbOrders.set(orderId, { ...o, quota_released_at: now() });
      for (const l of o.lines) {
        const it = items.get(l.item_id);
        if (it) items.set(it.id, { ...it, sold: Math.max(0, it.sold - l.qty) });
      }
      return true;
    },
    peekMatchSync(tenantId, matchId) {
      const m = matches.get(matchId);
      if (!m || m.tenant_id !== tenantId || m.status !== "suggested") return null;
      return { orderId: m.order_id, lineId: m.line_id };
    },
    commitMatchSync(tenantId, matchId, by) {
      const m = matches.get(matchId)!;
      matches.set(matchId, { ...m, status: "confirmed", decided_at: now(), decided_by: by });
      const l = lines.get(m.line_id);
      if (l && l.tenant_id === tenantId) lines.set(l.id, { ...l, status: "confirmed" });
    },
  };

  const store: Omit<GroupBuyStore, "confirmBankMatch"> = {
    async insertGroupBuy(row) {
      if ([...gbs.values()].some((g) => g.tenant_id === row.tenant_id && g.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const g: GroupBuyRow = { ...clone(row), id: randomUUID(), closed_at: null, settled_at: null, created_at: now(), updated_at: now() };
      gbs.set(g.id, g);
      return clone(g);
    },
    async updateGroupBuy(tenantId, id, patch) {
      const g = gbs.get(id);
      if (!g || g.tenant_id !== tenantId) return null;
      if (patch.slug && [...gbs.values()].some((x) => x.id !== id && x.tenant_id === tenantId && x.slug === patch.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const next = { ...g, ...clone(patch), updated_at: now() };
      gbs.set(id, next);
      return clone(next);
    },
    async transitionGroupBuy(tenantId, id, from, to, patch) {
      const g = gbs.get(id);
      if (!g || g.tenant_id !== tenantId || !from.includes(g.status)) return null;
      const next = { ...g, ...patch, status: to, updated_at: now() };
      gbs.set(id, next);
      return clone(next);
    },
    async markGroupBuySettled(tenantId, id) {
      const g = gbs.get(id);
      if (!g || g.tenant_id !== tenantId || g.settled_at) return false;
      gbs.set(id, { ...g, settled_at: now(), updated_at: now() });
      return true;
    },
    async getGroupBuy(tenantId, id) {
      const g = gbs.get(id);
      return g && g.tenant_id === tenantId ? clone(g) : null;
    },
    async getGroupBuyBySlug(tenantId, slug) {
      return clone([...gbs.values()].find((g) => g.tenant_id === tenantId && g.slug === slug) ?? null);
    },
    async listGroupBuys(tenantId, opts) {
      return clone(
        [...gbs.values()]
          .filter((g) => g.tenant_id === tenantId && (!opts.status?.length || opts.status.includes(g.status)))
          .sort((a, b) => a.ends_at.localeCompare(b.ends_at))
          .slice(0, opts.limit),
      );
    },
    async listDueGroupBuys(nowIso, limit) {
      return [...gbs.values()]
        .filter((g) => (g.status === "published" && g.ends_at <= nowIso) || ((g.status === "closed" || g.status === "failed") && !g.settled_at))
        .slice(0, limit)
        .map((g) => ({ id: g.id, tenant_id: g.tenant_id }));
    },
    async replaceGroupBuyItems(tenantId, groupBuyId, rows) {
      const existing = [...items.values()].filter((i) => i.tenant_id === tenantId && i.group_buy_id === groupBuyId);
      const byKey = new Map(existing.map((r) => [gbItemKey(r), r]));
      const want = new Set(rows.map(gbItemKey));
      for (const r of rows) {
        const hit = byKey.get(gbItemKey(r));
        if (hit && r.quota !== null && r.quota < hit.sold) throw new ServiceError("conflict", `品項限量不能低於已售數量（已售 ${hit.sold}）`);
      }
      for (const old of existing) if (!want.has(gbItemKey(old)) && old.sold > 0) throw new ServiceError("conflict", `已有訂單的品項不能移除（已售 ${old.sold}），可把限量改成已售數量來停售`);
      for (const r of rows) {
        const hit = byKey.get(gbItemKey(r));
        if (hit) items.set(hit.id, { ...hit, price: r.price, quota: r.quota, sort: r.sort });
        else {
          const it: GroupBuyItemRow = { ...clone(r), id: randomUUID(), tenant_id: tenantId, group_buy_id: groupBuyId, sold: 0, created_at: now() };
          items.set(it.id, it);
        }
      }
      for (const old of existing) if (!want.has(gbItemKey(old))) items.delete(old.id);
      return store.listGroupBuyItems(tenantId, groupBuyId);
    },
    async listGroupBuyItems(tenantId, groupBuyId) {
      return clone([...items.values()].filter((i) => i.tenant_id === tenantId && i.group_buy_id === groupBuyId).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at)));
    },

    async insertLeader(row) {
      if ([...leaders.values()].some((l) => l.tenant_id === row.tenant_id && (l.code === row.code || l.email_norm === row.email_norm))) return null;
      const l: GroupBuyLeaderRow = { ...clone(row), id: randomUUID(), status: "active", report_version: 1, created_at: now(), updated_at: now() };
      leaders.set(l.id, l);
      return clone(l);
    },
    async getLeader(tenantId, id) {
      const l = leaders.get(id);
      return l && l.tenant_id === tenantId ? clone(l) : null;
    },
    async getLeaderByCode(tenantId, code) {
      return clone([...leaders.values()].find((l) => l.tenant_id === tenantId && l.code === code) ?? null);
    },
    async getLeaderByEmail(tenantId, emailNorm) {
      return clone([...leaders.values()].find((l) => l.tenant_id === tenantId && l.email_norm === emailNorm) ?? null);
    },
    async updateLeader(tenantId, id, patch) {
      const l = leaders.get(id);
      if (!l || l.tenant_id !== tenantId) return null;
      const next = { ...l, ...patch, updated_at: now() };
      leaders.set(id, next);
      return clone(next);
    },
    async listLeaders(tenantId) {
      return clone([...leaders.values()].filter((l) => l.tenant_id === tenantId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
    },
    async upsertLeaderAssignment(row) {
      const prev = [...assignments.values()].find((a) => a.group_buy_id === row.group_buy_id && a.leader_id === row.leader_id);
      const next: LeaderAssignmentRow = { id: prev?.id ?? randomUUID(), created_at: prev?.created_at ?? now(), ...clone(row) };
      assignments.set(next.id, next);
      return clone(next);
    },
    async listLeaderAssignments(tenantId, opts) {
      return clone([...assignments.values()].filter((a) => a.tenant_id === tenantId && (!opts.groupBuyId || a.group_buy_id === opts.groupBuyId) && (!opts.leaderId || a.leader_id === opts.leaderId)));
    },

    async getGroupBuyOrder(tenantId, orderId) {
      const o = gbOrders.get(orderId);
      return o && o.tenant_id === tenantId ? clone(o) : null;
    },
    async setGroupBuyPayerLast5(tenantId, orderId, last5) {
      const o = gbOrders.get(orderId);
      if (!o || o.tenant_id !== tenantId) return false;
      gbOrders.set(orderId, { ...o, payer_last5: last5 });
      return true;
    },
    async listGroupBuyOrderRows(tenantId, opts) {
      return clone(
        [...gbOrders.values()].filter(
          (o) => o.tenant_id === tenantId && (!opts.groupBuyId || o.group_buy_id === opts.groupBuyId) && (!opts.leaderId || o.leader_id === opts.leaderId) && (!opts.orderIds || opts.orderIds.includes(o.order_id)),
        ),
      );
    },
    async insertGroupBuyCommission(row) {
      if (commissions.some((c) => c.order_id === row.order_id && c.kind === row.kind)) return false;
      commissions.push({ ...clone(row), id: ++seq, created_at: now() });
      return true;
    },
    async listGroupBuyCommissions(tenantId, opts) {
      return clone(commissions.filter((c) => c.tenant_id === tenantId && (!opts.leaderId || c.leader_id === opts.leaderId) && (!opts.groupBuyId || c.group_buy_id === opts.groupBuyId) && (!opts.orderIds || opts.orderIds.includes(c.order_id))));
    },
    async insertGroupBuyNotice(row) {
      const k = `${row.group_buy_id}|${row.order_id}|${row.kind}`;
      if (notices.has(k)) return false;
      notices.add(k);
      return true;
    },

    async insertBankImport(row) {
      const r: BankImportRow = { ...clone(row), id: randomUUID(), inserted_count: 0, created_at: now() };
      imports.set(r.id, r);
      return clone(r);
    },
    async setBankImportInserted(tenantId, id, inserted) {
      const r = imports.get(id);
      if (r && r.tenant_id === tenantId) imports.set(id, { ...r, inserted_count: inserted });
    },
    async insertBankLines(rows) {
      const out: BankLineRow[] = [];
      for (const r of rows) {
        if ([...lines.values()].some((l) => l.tenant_id === r.tenant_id && l.fingerprint === r.fingerprint)) continue;
        const l: BankLineRow = { ...clone(r), id: randomUUID(), status: "unmatched", created_at: now() };
        lines.set(l.id, l);
        out.push(clone(l));
      }
      return out;
    },
    async listBankLines(tenantId, opts) {
      return clone(
        [...lines.values()]
          .filter((l) => l.tenant_id === tenantId && (!opts.status?.length || opts.status.includes(l.status)) && (!opts.ids || opts.ids.includes(l.id)))
          .sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.created_at.localeCompare(b.created_at))
          .slice(0, opts.limit),
      );
    },
    async setBankLineStatus(tenantId, ids, status) {
      for (const id of ids) {
        const l = lines.get(id);
        if (l && l.tenant_id === tenantId && l.status !== "confirmed") lines.set(id, { ...l, status });
      }
    },
    async insertBankMatch(row) {
      if (activeMatch((m) => m.line_id === row.line_id) || activeMatch((m) => m.order_id === row.order_id)) return null;
      const m: BankMatchRow = { ...clone(row), id: randomUUID(), status: "suggested", reason: null, created_at: now(), decided_at: null, decided_by: null };
      matches.set(m.id, m);
      return clone(m);
    },
    async listBankMatches(tenantId, opts) {
      return clone(
        [...matches.values()]
          .filter((m) => m.tenant_id === tenantId && (!opts.status?.length || opts.status.includes(m.status)) && (!opts.ids || opts.ids.includes(m.id)))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, opts.limit),
      );
    },
    async decideBankMatch(tenantId, id, from, to, patch) {
      const m = matches.get(id);
      if (!m || m.tenant_id !== tenantId || m.status !== from) return false;
      matches.set(id, { ...m, status: to, reason: patch.reason ?? null, decided_by: patch.decided_by, decided_at: now() });
      return true;
    },
  };
  return { store, bridge };
}
