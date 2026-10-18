import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { OrderRow } from "./types";
import type { BankImportRow, BankLineRow, BankMatchRow, GroupBuyCommissionRow, GroupBuyItemRow, GroupBuyLeaderRow, GroupBuyOrderRow, GroupBuyRow, GroupBuyStore, LeaderAssignmentRow } from "./types-groupbuy";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);
const nowIso = () => new Date().toISOString();

/** 團購下單錯誤（Supabase 與記憶體實作共用同一句話） */
export const GB_CLOSED = "這個團購已截止或尚未開放，訂單未成立。";
export const gbQuotaMessage = (name: string) => `「${name}」團購數量已達上限，訂單未成立，請調整數量後再試。`;
export const BANK_MATCH_NOT_PAYABLE = "這張訂單已無法標記收款（可能已取消、已付款或不是匯款訂單）";

/** 依 product＋variant 比對品項 */
export const gbItemKey = (r: { product_id: string; variant_id: string | null }) => `${r.product_id}|${r.variant_id ?? ""}`;

export function mapGroupBuyRpcError(message: string): ServiceError | null {
  if (/group buy closed|group buy empty/.test(message)) return new ServiceError("conflict", GB_CLOSED);
  const m = /group buy quota: (.*)$/.exec(message);
  if (m) return new ServiceError("conflict", gbQuotaMessage(m[1]!));
  return null;
}

export function createSupabaseGroupBuyStore(db: SupabaseClient): GroupBuyStore {
  return {
    async insertGroupBuy(row) {
      return must(await db.from("builder_group_buys").insert(row).select("*").single(), "insertGroupBuy") as GroupBuyRow;
    },
    async updateGroupBuy(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_group_buys").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateGroupBuy") as GroupBuyRow | null;
    },
    async transitionGroupBuy(tenantId, id, from, to, patch) {
      if (!isUuid(id)) return null;
      return must(
        await db.from("builder_group_buys").update({ ...patch, status: to, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from).select("*").maybeSingle(),
        "transitionGroupBuy",
      ) as GroupBuyRow | null;
    },
    async markGroupBuySettled(tenantId, id) {
      const rows = must(await db.from("builder_group_buys").update({ settled_at: nowIso(), updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).is("settled_at", null).select("id"), "markGroupBuySettled") as { id: string }[];
      return rows.length > 0;
    },
    async getGroupBuy(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_group_buys").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getGroupBuy") as GroupBuyRow | null;
    },
    async getGroupBuyBySlug(tenantId, slug) {
      return must(await db.from("builder_group_buys").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getGroupBuyBySlug") as GroupBuyRow | null;
    },
    async listGroupBuys(tenantId, opts) {
      let q = db.from("builder_group_buys").select("*").eq("tenant_id", tenantId);
      if (opts.status?.length) q = q.in("status", opts.status);
      return (must(await q.order("ends_at", { ascending: true }).limit(opts.limit), "listGroupBuys") ?? []) as GroupBuyRow[];
    },
    async listDueGroupBuys(now, limit) {
      const a = (must(await db.from("builder_group_buys").select("id, tenant_id").eq("status", "published").lte("ends_at", now).order("ends_at").limit(limit), "listDueGroupBuys.open") ?? []) as Pick<GroupBuyRow, "id" | "tenant_id">[];
      const b = (must(await db.from("builder_group_buys").select("id, tenant_id").in("status", ["closed", "failed"]).is("settled_at", null).order("closed_at").limit(limit), "listDueGroupBuys.unsettled") ?? []) as Pick<GroupBuyRow, "id" | "tenant_id">[];
      return [...a, ...b].slice(0, limit);
    },
    async replaceGroupBuyItems(tenantId, groupBuyId, rows) {
      const existing = (must(await db.from("builder_group_buy_items").select("*").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId), "replaceGroupBuyItems.read") ?? []) as GroupBuyItemRow[];
      const byKey = new Map(existing.map((r) => [gbItemKey(r), r]));
      const want = new Set(rows.map(gbItemKey));
      for (const r of rows) {
        const hit = byKey.get(gbItemKey(r));
        if (hit && r.quota !== null && r.quota < hit.sold) throw new ServiceError("conflict", `品項限量不能低於已售數量（已售 ${hit.sold}）`);
      }
      for (const old of existing) if (!want.has(gbItemKey(old)) && old.sold > 0) throw new ServiceError("conflict", `已有訂單的品項不能移除（已售 ${old.sold}），可把限量改成已售數量來停售`);
      for (const r of rows) {
        const hit = byKey.get(gbItemKey(r));
        if (hit) {
          // 限量的條件更新：期間被訂單扣到超過新限量 → DB check 失敗 → 回 conflict
          const u = await db.from("builder_group_buy_items").update({ price: r.price, quota: r.quota, sort: r.sort }).eq("tenant_id", tenantId).eq("id", hit.id);
          if (u.error?.code === "23514") throw new ServiceError("conflict", "品項限量不能低於已售數量（剛有新訂單），請重新讀取後再改");
          must(u, "replaceGroupBuyItems.update");
        } else {
          must(await db.from("builder_group_buy_items").insert({ ...r, tenant_id: tenantId, group_buy_id: groupBuyId }), "replaceGroupBuyItems.insert");
        }
      }
      const drop = existing.filter((o) => !want.has(gbItemKey(o))).map((o) => o.id);
      if (drop.length) must(await db.from("builder_group_buy_items").delete().eq("tenant_id", tenantId).eq("sold", 0).in("id", drop), "replaceGroupBuyItems.delete");
      return (must(await db.from("builder_group_buy_items").select("*").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId).order("sort"), "replaceGroupBuyItems.list") ?? []) as GroupBuyItemRow[];
    },
    async listGroupBuyItems(tenantId, groupBuyId) {
      if (!isUuid(groupBuyId)) return [];
      return (must(await db.from("builder_group_buy_items").select("*").eq("tenant_id", tenantId).eq("group_buy_id", groupBuyId).order("sort").order("created_at"), "listGroupBuyItems") ?? []) as GroupBuyItemRow[];
    },

    async insertLeader(row) {
      const r = await db.from("builder_group_buy_leaders").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertLeader") as GroupBuyLeaderRow;
    },
    async getLeader(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_group_buy_leaders").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getLeader") as GroupBuyLeaderRow | null;
    },
    async getLeaderByCode(tenantId, code) {
      return must(await db.from("builder_group_buy_leaders").select("*").eq("tenant_id", tenantId).eq("code", code).maybeSingle(), "getLeaderByCode") as GroupBuyLeaderRow | null;
    },
    async getLeaderByEmail(tenantId, emailNorm) {
      return must(await db.from("builder_group_buy_leaders").select("*").eq("tenant_id", tenantId).eq("email_norm", emailNorm).maybeSingle(), "getLeaderByEmail") as GroupBuyLeaderRow | null;
    },
    async updateLeader(tenantId, id, patch) {
      return must(await db.from("builder_group_buy_leaders").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateLeader") as GroupBuyLeaderRow | null;
    },
    async listLeaders(tenantId) {
      return (must(await db.from("builder_group_buy_leaders").select("*").eq("tenant_id", tenantId).order("created_at").limit(500), "listLeaders") ?? []) as GroupBuyLeaderRow[];
    },
    async upsertLeaderAssignment(row) {
      return must(await db.from("builder_group_buy_leader_assignments").upsert(row, { onConflict: "group_buy_id,leader_id" }).select("*").single(), "upsertLeaderAssignment") as LeaderAssignmentRow;
    },
    async listLeaderAssignments(tenantId, opts) {
      let q = db.from("builder_group_buy_leader_assignments").select("*").eq("tenant_id", tenantId);
      if (opts.groupBuyId) q = q.eq("group_buy_id", opts.groupBuyId);
      if (opts.leaderId) q = q.eq("leader_id", opts.leaderId);
      return (must(await q.order("created_at").limit(1000), "listLeaderAssignments") ?? []) as LeaderAssignmentRow[];
    },

    async getGroupBuyOrder(tenantId, orderId) {
      if (!isUuid(orderId)) return null;
      return must(await db.from("builder_group_buy_orders").select("*").eq("tenant_id", tenantId).eq("order_id", orderId).maybeSingle(), "getGroupBuyOrder") as GroupBuyOrderRow | null;
    },
    async setGroupBuyPayerLast5(tenantId, orderId, last5) {
      if (!isUuid(orderId)) return false;
      const rows = must(await db.from("builder_group_buy_orders").update({ payer_last5: last5 }).eq("tenant_id", tenantId).eq("order_id", orderId).select("order_id"), "setGroupBuyPayerLast5") as { order_id: string }[];
      return rows.length > 0;
    },
    async listGroupBuyOrderRows(tenantId, opts) {
      let q = db.from("builder_group_buy_orders").select("*").eq("tenant_id", tenantId);
      if (opts.groupBuyId) q = q.eq("group_buy_id", opts.groupBuyId);
      if (opts.leaderId) q = q.eq("leader_id", opts.leaderId);
      if (opts.orderIds) {
        const ids = opts.orderIds.filter(isUuid);
        if (!ids.length) return [];
        q = q.in("order_id", ids);
      }
      return (must(await q.limit(5000), "listGroupBuyOrderRows") ?? []) as GroupBuyOrderRow[];
    },
    async insertGroupBuyCommission(row) {
      const r = await db.from("builder_group_buy_commissions").insert(row);
      if (r.error?.code === "23505") return false;
      must(r, "insertGroupBuyCommission");
      return true;
    },
    async listGroupBuyCommissions(tenantId, opts) {
      let q = db.from("builder_group_buy_commissions").select("*").eq("tenant_id", tenantId);
      if (opts.leaderId) q = q.eq("leader_id", opts.leaderId);
      if (opts.groupBuyId) q = q.eq("group_buy_id", opts.groupBuyId);
      if (opts.orderIds) {
        const ids = opts.orderIds.filter(isUuid);
        if (!ids.length) return [];
        q = q.in("order_id", ids);
      }
      return (must(await q.order("id").limit(5000), "listGroupBuyCommissions") ?? []) as GroupBuyCommissionRow[];
    },
    async insertGroupBuyNotice(row) {
      const r = await db.from("builder_group_buy_notices").insert(row);
      if (r.error?.code === "23505") return false;
      must(r, "insertGroupBuyNotice");
      return true;
    },

    async insertBankImport(row) {
      return must(await db.from("builder_bank_imports").insert(row).select("*").single(), "insertBankImport") as BankImportRow;
    },
    async setBankImportInserted(tenantId, id, inserted) {
      must(await db.from("builder_bank_imports").update({ inserted_count: inserted }).eq("tenant_id", tenantId).eq("id", id), "setBankImportInserted");
    },
    async insertBankLines(rows) {
      if (!rows.length) return [];
      return (must(await db.from("builder_bank_lines").upsert(rows, { onConflict: "tenant_id,fingerprint", ignoreDuplicates: true }).select("*"), "insertBankLines") ?? []) as BankLineRow[];
    },
    async listBankLines(tenantId, opts) {
      let q = db.from("builder_bank_lines").select("*").eq("tenant_id", tenantId);
      if (opts.status?.length) q = q.in("status", opts.status);
      if (opts.ids) {
        const ids = opts.ids.filter(isUuid);
        if (!ids.length) return [];
        q = q.in("id", ids);
      }
      return (must(await q.order("txn_date").order("created_at").limit(opts.limit), "listBankLines") ?? []) as BankLineRow[];
    },
    async setBankLineStatus(tenantId, ids, status) {
      const valid = ids.filter(isUuid);
      if (!valid.length) return;
      must(await db.from("builder_bank_lines").update({ status }).eq("tenant_id", tenantId).in("id", valid).neq("status", "confirmed"), "setBankLineStatus");
    },
    async insertBankMatch(row) {
      const r = await db.from("builder_bank_matches").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertBankMatch") as BankMatchRow;
    },
    async listBankMatches(tenantId, opts) {
      let q = db.from("builder_bank_matches").select("*").eq("tenant_id", tenantId);
      if (opts.status?.length) q = q.in("status", opts.status);
      if (opts.ids) {
        const ids = opts.ids.filter(isUuid);
        if (!ids.length) return [];
        q = q.in("id", ids);
      }
      return (must(await q.order("created_at", { ascending: false }).limit(opts.limit), "listBankMatches") ?? []) as BankMatchRow[];
    },
    async decideBankMatch(tenantId, id, from, to, patch) {
      if (!isUuid(id)) return false;
      const rows = must(
        await db.from("builder_bank_matches").update({ status: to, reason: patch.reason ?? null, decided_by: patch.decided_by, decided_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).eq("status", from).select("id"),
        "decideBankMatch",
      ) as { id: string }[];
      return rows.length > 0;
    },
    async confirmBankMatch(tenantId, matchId, by) {
      if (!isUuid(matchId)) return null;
      const r = await db.rpc("builder_confirm_bank_match", { p_tenant: tenantId, p_match: matchId, p_by: by });
      if (r.error) {
        if (/bank match order not payable/.test(r.error.message)) throw new ServiceError("conflict", BANK_MATCH_NOT_PAYABLE);
        if (r.error.code === "23505") throw new ServiceError("conflict", "這筆明細或訂單已經有其他已確認的配對");
        throw new Error(`confirmBankMatch: ${r.error.message}`);
      }
      return ((r.data as OrderRow[] | null) ?? [])[0] ?? null;
    },
  };
}
