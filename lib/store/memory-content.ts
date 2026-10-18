import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import { computeLedgerState } from "../loyalty/ledger";
import { CREDIT_ERRORS } from "./supabase-content";
import type { ContentStore, CreditLedger, CreditLedgerRow, CreditPostInput, MemberTierRow, SearchHit, TopupPlanRow, TranslationRow, PersonRow, DocumentRow, CertificateRow, CertLookupRow } from "./types-content";
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
  const translations = new Map<string, TranslationRow>();
  /** directory／downloads 的記憶體搜尋來源（各模組的記憶體實作接上） */
  const extraSearch: ((tenantId: string, q: string) => Promise<SearchHit[]>)[] = [];
  const people = new Map<string, PersonRow>();
  const documents = new Map<string, DocumentRow>();
  const certs = new Map<string, CertificateRow>();
  const certLookups: CertLookupRow[] = [];
  extraSearch.push(async (tenantId, q) =>
    [...documents.values()]
      .filter((d) => d.tenant_id === tenantId && d.status === "published" && d.visibility === "public" && [d.title, d.description, d.category].some((x) => (x ?? "").toLowerCase().includes(q)))
      .map((d) => ({ kind: "document", id: d.id, slug: null, title: d.title, body: `${d.category ?? ""}\n${d.description ?? ""}`, rank: d.title.toLowerCase().includes(q) ? 2 : 1 })),
  );
  extraSearch.push(async (tenantId, q) =>
    [...people.values()]
      .filter((p) => p.tenant_id === tenantId && p.status === "published" && [p.name, p.title, p.category, p.bio_md].some((x) => (x ?? "").toLowerCase().includes(q)))
      .map((p) => ({ kind: "person", id: p.id, slug: p.slug, title: p.name, body: `${p.title ?? ""}\n${p.category ?? ""}\n${p.bio_md}`, rank: p.name.toLowerCase().includes(q) ? 2 : 1 })),
  );
  const trKey = (r: Pick<TranslationRow, "tenant_id" | "entity_type" | "entity_id" | "lang" | "field">) => `${r.tenant_id}|${r.entity_type}|${r.entity_id}|${r.lang}|${r.field}`;

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
    async upsertCertificates(rows) {
      let inserted = 0;
      let updated = 0;
      for (const r of rows) {
        const cur = [...certs.values()].find((c) => c.tenant_id === r.tenant_id && c.cert_no === r.cert_no);
        if (cur) {
          certs.set(cur.id, { ...cur, ...clone(r), updated_at: now() });
          updated++;
        } else {
          const id = randomUUID();
          certs.set(id, { ...clone(r), id, created_at: now(), updated_at: now() });
          inserted++;
        }
      }
      return { inserted, updated };
    },
    async getCertificateByNo(tenantId, certNo) {
      return clone([...certs.values()].find((c) => c.tenant_id === tenantId && c.cert_no === certNo) ?? null);
    },
    async findCertificatesByNameBirth(tenantId, nameNorm, birth) {
      return clone([...certs.values()].filter((c) => c.tenant_id === tenantId && c.name_norm === nameNorm && c.birth_date === birth));
    },
    async listCertificates(tenantId, opts) {
      const rows = [...certs.values()].filter((c) => c.tenant_id === tenantId && (!opts.q || c.cert_no === opts.q)).sort((a, b) => (b.issued_on ?? "").localeCompare(a.issued_on ?? "") || a.cert_no.localeCompare(b.cert_no));
      return { rows: clone(rows.slice(opts.offset, opts.offset + opts.limit)), total: rows.length };
    },
    async updateCertificate(tenantId, id, patch) {
      const c = certs.get(id);
      if (!c || c.tenant_id !== tenantId) return null;
      const next = { ...c, ...patch, updated_at: now() };
      certs.set(id, next);
      return clone(next);
    },
    async insertCertLookup(row) {
      certLookups.push({ ...row, id: certLookups.length + 1, at: now() });
    },
    async listCertLookups(tenantId, limit) {
      return clone(certLookups.filter((l) => l.tenant_id === tenantId).slice(-limit).reverse());
    },
    async insertDocument(row) {
      const r: DocumentRow = { ...clone(row), id: row.id ?? randomUUID(), download_count: 0, created_at: now(), updated_at: now() };
      if (r.file_path && !r.file_path.startsWith(`${r.tenant_id}/`)) throw new Error("file_path 必須在租戶資料夾");
      documents.set(r.id, r);
      return clone(r);
    },
    async updateDocument(tenantId, id, patch) {
      const d = documents.get(id);
      if (!d || d.tenant_id !== tenantId) return null;
      const next = { ...d, ...clone(patch), updated_at: now() };
      documents.set(id, next);
      return clone(next);
    },
    async getDocument(tenantId, id) {
      const d = documents.get(id);
      return d && d.tenant_id === tenantId ? clone(d) : null;
    },
    async listDocuments(tenantId, opts) {
      return clone([...documents.values()].filter((d) => d.tenant_id === tenantId && (!opts.status || d.status === opts.status) && (!opts.visibility || d.visibility === opts.visibility)).sort((a, b) => a.sort - b.sort || b.created_at.localeCompare(a.created_at)));
    },
    async bumpDownload(tenantId, id) {
      const d = documents.get(id);
      if (!d || d.tenant_id !== tenantId || d.status !== "published") return null;
      documents.set(id, { ...d, download_count: d.download_count + 1 });
      return d.download_count + 1;
    },
    async insertPerson(row) {
      if ([...people.values()].some((p) => p.tenant_id === row.tenant_id && p.slug === row.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const r: PersonRow = { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      people.set(r.id, r);
      return clone(r);
    },
    async updatePerson(tenantId, id, patch) {
      const p = people.get(id);
      if (!p || p.tenant_id !== tenantId) return null;
      if (patch.slug && patch.slug !== p.slug && [...people.values()].some((x) => x.tenant_id === tenantId && x.slug === patch.slug)) throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      const next = { ...p, ...clone(patch), updated_at: now() };
      people.set(id, next);
      return clone(next);
    },
    async getPersonById(tenantId, id) {
      const p = people.get(id);
      return p && p.tenant_id === tenantId ? clone(p) : null;
    },
    async getPersonBySlug(tenantId, slug) {
      return clone([...people.values()].find((p) => p.tenant_id === tenantId && p.slug === slug) ?? null);
    },
    async listPeople(tenantId, opts) {
      return clone([...people.values()].filter((p) => p.tenant_id === tenantId && (!opts.status || p.status === opts.status) && (!opts.category || p.category === opts.category)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)));
    },
    async searchContent(tenantId, qRaw, lang, limit) {
      // 同 SQL builder_search_content：lower 片語比對、只搜已發布、課程只比對介紹與單元標題
      if (!root) return [];
      const q = qRaw.trim().toLowerCase();
      if (!q || q.length > 60) return [];
      const has = (...xs: (string | null | undefined)[]) => xs.some((x) => (x ?? "").toLowerCase().includes(q));
      const out: SearchHit[] = [];
      const nowIso = now();
      for (const p of (await root.listPosts(tenantId, { status: "published", limit: 1000, offset: 0 })).rows) {
        if (p.published_at && p.published_at <= nowIso && has(p.title, p.excerpt, p.body_md)) out.push({ kind: "post", id: p.id, slug: p.slug, title: p.title, body: `${p.excerpt ?? ""}\n${p.body_md}`, rank: has(p.title) ? 2 : 1 });
      }
      for (const p of (await root.listProducts(tenantId, { status: "published", limit: 1000, offset: 0 })).rows) {
        if (has(p.name, p.description_md)) out.push({ kind: "product", id: p.id, slug: p.slug, title: p.name, body: p.description_md, rank: has(p.name) ? 2 : 1 });
      }
      for (const e of (await root.listEvents(tenantId, { status: "published", limit: 1000, offset: 0 })).rows) {
        if (has(e.title, e.summary, e.body_md)) out.push({ kind: "event", id: e.id, slug: e.slug, title: e.title, body: `${e.summary ?? ""}\n${e.body_md}`, rank: has(e.title) ? 2 : 1 });
      }
      const courses = await root.listCourses(tenantId, { status: "published" });
      const lessons = await root.listLessons(tenantId, courses.map((c) => c.id));
      for (const c of courses) {
        const lessonHit = lessons.some((l) => l.course_id === c.id && l.status === "published" && has(l.title));
        if (has(c.title, c.summary, c.body_md) || lessonHit) out.push({ kind: "course", id: c.id, slug: c.slug, title: c.title, body: `${c.summary ?? ""}\n${c.body_md}`, rank: has(c.title) ? 2 : 1 });
      }
      if (lang) {
        for (const t of translations.values()) {
          if (t.tenant_id === tenantId && t.lang === lang && t.published_value && t.published_value.toLowerCase().includes(q)) out.push({ kind: t.entity_type, id: t.entity_id, slug: null, title: null, body: t.published_value, rank: 1 });
        }
      }
      for (const x of extraSearch) out.push(...(await x(tenantId, q)));
      return out.sort((a, b) => b.rank - a.rank).slice(0, limit * 2);
    },
    async upsertTranslationDrafts(rows) {
      for (const r of rows) {
        const k = trKey(r);
        const cur = translations.get(k);
        translations.set(k, { ...(cur ?? { id: randomUUID(), published_value: null, published_ai: false, published_at: null }), ...clone(r), draft_updated_at: now() } as TranslationRow);
      }
    },
    async listTranslations(tenantId, opts) {
      return clone([...translations.values()].filter((t) => t.tenant_id === tenantId && (!opts.lang || t.lang === opts.lang) && (!opts.entityType || t.entity_type === opts.entityType) && (!opts.entityIds || opts.entityIds.includes(t.entity_id))));
    },
    async publishTranslationDrafts(tenantId, opts, by) {
      let n = 0;
      for (const [k, t] of translations) {
        if (t.tenant_id !== tenantId || t.draft_value === null || (opts.lang && t.lang !== opts.lang) || (opts.entityType && t.entity_type !== opts.entityType) || (opts.entityId && t.entity_id !== opts.entityId)) continue;
        if (t.draft_value === t.published_value && t.draft_ai === t.published_ai) continue;
        translations.set(k, { ...t, published_value: t.draft_value, published_ai: t.draft_ai, published_at: now(), updated_by: by });
        n++;
      }
      return n;
    },
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
