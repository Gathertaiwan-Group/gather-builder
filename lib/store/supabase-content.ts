import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { ContentStore, CreditLedger, CreditLedgerRow, MemberTierRow, SearchHit, TopupPlanRow, TranslationRow, PersonRow, DocumentRow, CertificateRow, CertLookupRow, ReviewRow, AnnouncementRow, AnnouncementAckRow } from "./types-content";

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
    async insertAnnouncement(row) {
      return must(await db.from("builder_announcements").insert(row).select("*").single(), "insertAnnouncement") as AnnouncementRow;
    },
    async updateAnnouncement(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_announcements").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateAnnouncement") as AnnouncementRow | null;
    },
    async getAnnouncement(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_announcements").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getAnnouncement") as AnnouncementRow | null;
    },
    async listAnnouncements(tenantId, opts) {
      let q = db.from("builder_announcements").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return (must(await q.order("pinned", { ascending: false }).order("starts_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(500), "listAnnouncements") ?? []) as AnnouncementRow[];
    },
    async insertAnnouncementAck(row) {
      const r = await db.from("builder_announcement_acks").insert(row);
      if (r.error?.code === "23505") return false;
      must(r, "insertAnnouncementAck");
      return true;
    },
    async listAnnouncementAcks(tenantId, opts) {
      let q = db.from("builder_announcement_acks").select("*").eq("tenant_id", tenantId);
      if (opts.announcementId) {
        if (!isUuid(opts.announcementId)) return [];
        q = q.eq("announcement_id", opts.announcementId);
      }
      if (opts.memberId) {
        if (!isUuid(opts.memberId)) return [];
        q = q.eq("member_id", opts.memberId);
      }
      return (must(await q.order("id").limit(5000), "listAnnouncementAcks") ?? []) as AnnouncementAckRow[];
    },
    async insertReview(row) {
      const r = await db.from("builder_reviews").insert(row).select("*").single();
      if (r.error?.code === "23505") throw new ServiceError("conflict", "這筆訂單的這個商品已經評價過了");
      return must(r, "insertReview") as ReviewRow;
    },
    async updateReview(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_reviews").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateReview") as ReviewRow | null;
    },
    async getReview(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_reviews").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getReview") as ReviewRow | null;
    },
    async listReviews(tenantId, opts) {
      let q = db.from("builder_reviews").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.productId) {
        if (!isUuid(opts.productId)) return { rows: [], total: 0 };
        q = q.eq("product_id", opts.productId);
      }
      if (opts.memberId) {
        if (!isUuid(opts.memberId)) return { rows: [], total: 0 };
        q = q.eq("member_id", opts.memberId);
      }
      if (opts.status) q = q.eq("status", opts.status);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listReviews: ${r.error.message}`);
      return { rows: (r.data ?? []) as ReviewRow[], total: r.count ?? 0 };
    },
    async upsertCertificates(rows) {
      if (!rows.length) return { inserted: 0, updated: 0 };
      const tenantId = rows[0]!.tenant_id;
      const existing = new Set<string>();
      for (let i = 0; i < rows.length; i += 200) {
        const nos = rows.slice(i, i + 200).map((r) => r.cert_no);
        for (const r of (must(await db.from("builder_certificates").select("cert_no").eq("tenant_id", tenantId).in("cert_no", nos), "upsertCertificates.get") ?? []) as { cert_no: string }[]) existing.add(r.cert_no);
      }
      for (let i = 0; i < rows.length; i += 200) {
        must(await db.from("builder_certificates").upsert(rows.slice(i, i + 200).map((r) => ({ ...r, updated_at: nowIso() })), { onConflict: "tenant_id,cert_no" }), "upsertCertificates");
      }
      const updated = rows.filter((r) => existing.has(r.cert_no)).length;
      return { inserted: rows.length - updated, updated };
    },
    async getCertificateByNo(tenantId, certNo) {
      return must(await db.from("builder_certificates").select("*").eq("tenant_id", tenantId).eq("cert_no", certNo).maybeSingle(), "getCertificateByNo") as CertificateRow | null;
    },
    async findCertificatesByNameBirth(tenantId, nameNorm, birth) {
      return (must(await db.from("builder_certificates").select("*").eq("tenant_id", tenantId).eq("name_norm", nameNorm).eq("birth_date", birth).limit(20), "findCertificatesByNameBirth") ?? []) as CertificateRow[];
    },
    async listCertificates(tenantId, opts) {
      let q = db.from("builder_certificates").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.q && /^[A-Z0-9]{1,40}$/.test(opts.q)) q = q.eq("cert_no", opts.q);
      const r = await q.order("issued_on", { ascending: false, nullsFirst: false }).order("cert_no").range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listCertificates: ${r.error.message}`);
      return { rows: (r.data ?? []) as CertificateRow[], total: r.count ?? 0 };
    },
    async updateCertificate(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_certificates").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateCertificate") as CertificateRow | null;
    },
    async insertCertLookup(row) {
      must(await db.from("builder_cert_lookups").insert(row), "insertCertLookup");
    },
    async listCertLookups(tenantId, limit) {
      return (must(await db.from("builder_cert_lookups").select("*").eq("tenant_id", tenantId).order("id", { ascending: false }).limit(limit), "listCertLookups") ?? []) as CertLookupRow[];
    },
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
      return (must(await db.from(LEDGER_TABLE[ledger]).select("*").eq("tenant_id", tenantId).eq("member_id", memberId).order("seq", { ascending: false }).limit(limit), "listCreditLedger") ?? []) as CreditLedgerRow[];
    },
    async allCreditEntries(ledger, tenantId, memberId) {
      if (!isUuid(memberId)) return [];
      return (must(await db.from(LEDGER_TABLE[ledger]).select("*").eq("tenant_id", tenantId).eq("member_id", memberId).order("seq").limit(5000), "allCreditEntries") ?? []) as CreditLedgerRow[];
    },
    async getCreditByRef(ledger, tenantId, ref) {
      return must(await db.from(LEDGER_TABLE[ledger]).select("*").eq("tenant_id", tenantId).eq("ref", ref).maybeSingle(), "getCreditByRef") as CreditLedgerRow | null;
    },
    async listCreditMembersWithExpiry(ledger, fromIso, toIso, limit) {
      const rows = (must(await db.from(LEDGER_TABLE[ledger]).select("tenant_id, member_id").gt("amount", 0).gte("expires_at", fromIso).lt("expires_at", toIso).limit(limit * 4), "listCreditMembersWithExpiry") ?? []) as { tenant_id: string; member_id: string }[];
      const seen = new Set<string>();
      return rows.filter((r) => (seen.has(`${r.tenant_id}|${r.member_id}`) ? false : (seen.add(`${r.tenant_id}|${r.member_id}`), true))).slice(0, limit);
    },
    async sumCreditKindSince(ledger, tenantId, kind, sinceIso) {
      const rows = (must(await db.from(LEDGER_TABLE[ledger]).select("amount").eq("tenant_id", tenantId).eq("kind", kind).gte("created_at", sinceIso).limit(10000), "sumCreditKindSince") ?? []) as { amount: number }[];
      return rows.reduce((n, r) => n + Math.abs(Number(r.amount)), 0);
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
