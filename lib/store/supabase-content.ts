import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { ContentStore, CreditLedger, CreditLedgerRow, MemberTierRow, SearchHit, TopupPlanRow, TranslationRow, PersonRow, DocumentRow } from "./types-content";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined) => !!s && UUID.test(s);
const nowIso = () => new Date().toISOString();

export const LEDGER_TABLE: Record<CreditLedger, string> = { points: "builder_points_ledger", wallet: "builder_wallet_ledger" };

/** SQL raise 'builder: points insufficient' 等 → 客人看得懂的訊息（記憶體版共用） */
export const CREDIT_ERRORS: Record<string, string> = {
  "points insufficient": "點數不足（可能剛被其他訂單用掉或已到期），訂單未成立，請重新整理後再試。",
  "wallet insufficient": "儲值金餘額不足，訂單未成立，請重新整理後再試。",
  "wallet unavailable": "此商店未開放儲值金付款。",
  "credits need member": "使用點數或儲值金需要先登入會員。",
};

export function mapCreditError(message: string): ServiceError | null {
  for (const [k, v] of Object.entries(CREDIT_ERRORS)) if (message.includes(`builder: ${k}`)) return new ServiceError("conflict", v);
  return null;
}

/** 第五、六批的 Supabase 實作（所有查詢都帶 tenant_id） */
export function createSupabaseContentStore(db: SupabaseClient): ContentStore {
  return {
    async insertDocument(row) {
      return must(await db.from("builder_documents").insert(row).select("*").single(), "insertDocument") as DocumentRow;
    },
    async updateDocument(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_documents").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateDocument") as DocumentRow | null;
    },
    async getDocument(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_documents").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getDocument") as DocumentRow | null;
    },
    async listDocuments(tenantId, opts) {
      let q = db.from("builder_documents").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.visibility) q = q.eq("visibility", opts.visibility);
      return (must(await q.order("sort").order("created_at", { ascending: false }).limit(1000), "listDocuments") ?? []) as DocumentRow[];
    },
    async bumpDownload(tenantId, id) {
      if (!isUuid(id)) return null;
      const r = must(await db.rpc("builder_bump_download", { p_tenant: tenantId, p_doc: id }), "bumpDownload");
      return r === null || r === undefined ? null : Number(r);
    },
    async insertPerson(row) {
      return must(await db.from("builder_people").insert(row).select("*").single(), "insertPerson") as PersonRow;
    },
    async updatePerson(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_people").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updatePerson") as PersonRow | null;
    },
    async getPersonById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_people").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getPersonById") as PersonRow | null;
    },
    async getPersonBySlug(tenantId, slug) {
      return must(await db.from("builder_people").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getPersonBySlug") as PersonRow | null;
    },
    async listPeople(tenantId, opts) {
      let q = db.from("builder_people").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.category) q = q.eq("category", opts.category);
      return (must(await q.order("sort").order("name").limit(1000), "listPeople") ?? []) as PersonRow[];
    },
    async searchContent(tenantId, q, lang, limit) {
      return (must(await db.rpc("builder_search_content", { p_tenant: tenantId, p_q: q, p_lang: lang, p_limit: limit }), "searchContent") ?? []) as SearchHit[];
    },
    async upsertTranslationDrafts(rows) {
      if (!rows.length) return;
      const now = nowIso();
      must(await db.from("builder_translations").upsert(rows.map((r) => ({ ...r, draft_updated_at: now })), { onConflict: "tenant_id,entity_type,entity_id,lang,field" }), "upsertTranslationDrafts");
    },
    async listTranslations(tenantId, opts) {
      let q = db.from("builder_translations").select("*").eq("tenant_id", tenantId);
      if (opts.lang) q = q.eq("lang", opts.lang);
      if (opts.entityType) q = q.eq("entity_type", opts.entityType);
      if (opts.entityIds) {
        const ids = opts.entityIds.filter(isUuid);
        if (!ids.length) return [];
        q = q.in("entity_id", ids.slice(0, 500));
      }
      return (must(await q.limit(5000), "listTranslations") ?? []) as TranslationRow[];
    },
    async publishTranslationDrafts(tenantId, opts, by) {
      let q = db.from("builder_translations").select("*").eq("tenant_id", tenantId).not("draft_value", "is", null);
      if (opts.lang) q = q.eq("lang", opts.lang);
      if (opts.entityType) q = q.eq("entity_type", opts.entityType);
      if (opts.entityId) {
        if (!isUuid(opts.entityId)) return 0;
        q = q.eq("entity_id", opts.entityId);
      }
      const rows = ((must(await q.limit(5000), "publishTranslationDrafts.list") ?? []) as TranslationRow[]).filter((r) => r.draft_value !== r.published_value || r.draft_ai !== r.published_ai);
      const now = nowIso();
      for (const r of rows) {
        must(await db.from("builder_translations").update({ published_value: r.draft_value, published_ai: r.draft_ai, published_at: now, updated_by: by }).eq("id", r.id).eq("tenant_id", tenantId), "publishTranslationDrafts");
      }
      return rows.length;
    },
    async insertTopupPlan(row) {
      return must(await db.from("builder_topup_plans").insert(row).select("*").single(), "insertTopupPlan") as TopupPlanRow;
    },
    async updateTopupPlan(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_topup_plans").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateTopupPlan") as TopupPlanRow | null;
    },
    async getTopupPlan(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_topup_plans").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getTopupPlan") as TopupPlanRow | null;
    },
    async listTopupPlans(tenantId, opts) {
      let q = db.from("builder_topup_plans").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return (must(await q.order("sort").order("pay_amount"), "listTopupPlans") ?? []) as TopupPlanRow[];
    },
    async creditPost(ledger, i) {
      const r = await db.rpc("builder_ledger_post", {
        p_table: LEDGER_TABLE[ledger],
        p_tenant: i.tenantId,
        p_member: i.memberId,
        p_kind: i.kind,
        p_amount: i.amount,
        p_expires: i.expiresAt ?? null,
        p_ref: i.ref ?? null,
        p_order: i.orderId ?? null,
        p_reason: i.reason ?? null,
        p_actor: i.actor ?? "system",
        p_meta: i.meta ?? {},
        p_mode: i.mode,
      });
      if (r.error) {
        const m = mapCreditError(r.error.message);
        if (m) throw m;
        throw new Error(`creditPost: ${r.error.message}`);
      }
      const row = (r.data as { posted: boolean; amount: number; balance: number }[])[0]!;
      return { posted: row.posted, amount: Number(row.amount), balance: Number(row.balance) };
    },
    async creditState(ledger, tenantId, memberId) {
      const rows = must(await db.rpc("builder_ledger_state", { p_table: LEDGER_TABLE[ledger], p_tenant: tenantId, p_member: memberId, p_now: nowIso() }), "creditState") as { balance: number; available: number; expired_due: number; next_expiry: string | null }[];
      const s = rows[0];
      return { balance: Number(s?.balance ?? 0), available: Number(s?.available ?? 0), expiredDue: Number(s?.expired_due ?? 0), nextExpiry: s?.next_expiry ?? null };
    },
    async listCreditLedger(ledger, tenantId, memberId, limit) {
      if (!isUuid(memberId)) return [];
      return (must(await db.from(LEDGER_TABLE[ledger]).select("*").eq("tenant_id", tenantId).eq("member_id", memberId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit), "listCreditLedger") ?? []) as CreditLedgerRow[];
    },
    async allCreditEntries(ledger, tenantId, memberId) {
      if (!isUuid(memberId)) return [];
      return (must(await db.from(LEDGER_TABLE[ledger]).select("*").eq("tenant_id", tenantId).eq("member_id", memberId).order("created_at").order("id").limit(5000), "allCreditEntries") ?? []) as CreditLedgerRow[];
    },
    async getCreditByRef(ledger, tenantId, ref) {
      return must(await db.from(LEDGER_TABLE[ledger]).select("*").eq("tenant_id", tenantId).eq("ref", ref).maybeSingle(), "getCreditByRef") as CreditLedgerRow | null;
    },
    async listCreditMembersWithExpiry(ledger, fromIso, toIso, limit) {
      const rows = (must(await db.from(LEDGER_TABLE[ledger]).select("tenant_id, member_id").gt("amount", 0).gte("expires_at", fromIso).lt("expires_at", toIso).limit(limit * 4), "listCreditMembersWithExpiry") ?? []) as { tenant_id: string; member_id: string }[];
      const seen = new Set<string>();
      return rows.filter((r) => (seen.has(`${r.tenant_id}|${r.member_id}`) ? false : (seen.add(`${r.tenant_id}|${r.member_id}`), true))).slice(0, limit);
    },
    async creditExpire(ledger, tenantId, memberId) {
      return Number(must(await db.rpc("builder_ledger_expire", { p_table: LEDGER_TABLE[ledger], p_tenant: tenantId, p_member: memberId }), "creditExpire") ?? 0);
    },
    async memberSpend(tenantId, memberId, sinceIso) {
      if (!isUuid(memberId)) return 0;
      return Number(must(await db.rpc("builder_member_spend", { p_tenant: tenantId, p_member: memberId, p_since: sinceIso }), "memberSpend") ?? 0);
    },
    async getMemberTier(tenantId, memberId) {
      if (!isUuid(memberId)) return null;
      return must(await db.from("builder_member_tiers").select("*").eq("tenant_id", tenantId).eq("member_id", memberId).maybeSingle(), "getMemberTier") as MemberTierRow | null;
    },
    async upsertMemberTier(row) {
      const { changed, ...rest } = row;
      const patch: Record<string, unknown> = { ...rest, evaluated_at: nowIso() };
      if (changed) patch.changed_at = nowIso();
      must(await db.from("builder_member_tiers").upsert(patch, { onConflict: "tenant_id,member_id" }), "upsertMemberTier");
    },
    async listMemberTiers(tenantId, limit) {
      return (must(await db.from("builder_member_tiers").select("*").eq("tenant_id", tenantId).order("evaluated_at").limit(limit), "listMemberTiers") ?? []) as MemberTierRow[];
    },
  };
}
