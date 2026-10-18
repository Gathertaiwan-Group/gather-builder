import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import type { OrderLinkedExt } from "./types";
import type {
  AiChatRow,
  BroadcastRow,
  ExtStore,
  CvsSelectionRow,
  DeliveryRow,
  InvoiceAccountRow,
  InvoiceRow,
  ReferralCodeRow,
  ReferralLedgerRow,
  ReferralRow,
  ShipmentRow,
  ShippingAccountRow,
  SubscriberRow,
} from "./types-ext";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

export type ExtImpl = Omit<ExtStore, OrderLinkedExt>;
type MemoryExt = ExtImpl;

/**
 * 第三批模組的記憶體實作，語意與 Supabase 實作（唯一約束、條件更新）一致：
 * 每個方法的讀＋寫都在同一個同步區段完成（JS 單執行緒），等同 DB 的原子條件更新。
 */
export function createMemoryExtStore(): MemoryExt {
  const invoiceAccounts = new Map<string, InvoiceAccountRow>();
  const invoices = new Map<string, InvoiceRow>();
  const shipAccounts = new Map<string, ShippingAccountRow>();
  const cvs = new Map<string, CvsSelectionRow>();
  const shipments = new Map<string, ShipmentRow>();
  const refCodes = new Map<string, ReferralCodeRow>();
  const referrals = new Map<string, ReferralRow>();
  const ledger: ReferralLedgerRow[] = [];
  const subscribers = new Map<string, SubscriberRow>();
  const broadcasts = new Map<string, BroadcastRow>();
  const deliveries = new Map<string, DeliveryRow>();
  const chats = new Map<string, AiChatRow>();

  const page = <T>(rows: T[], limit: number, offset: number) => ({ rows: clone(rows.slice(offset, offset + limit)), total: rows.length });
  const byNewest = <T extends { created_at: string }>(a: T, b: T) => b.created_at.localeCompare(a.created_at);

  return {
    /* -------------------------------------------------------- invoice */
    async getInvoiceAccount(tenantId) {
      return clone(invoiceAccounts.get(tenantId) ?? null);
    },
    async upsertInvoiceAccount(row) {
      const prev = invoiceAccounts.get(row.tenant_id);
      const next: InvoiceAccountRow = { id: prev?.id ?? randomUUID(), created_at: prev?.created_at ?? now(), ...row, status: "unverified", verified_at: null, last_error: null, updated_at: now() };
      invoiceAccounts.set(row.tenant_id, next);
      return clone(next);
    },
    async markInvoiceAccount(tenantId, patch) {
      const a = invoiceAccounts.get(tenantId);
      if (a) invoiceAccounts.set(tenantId, { ...a, ...patch, updated_at: now() });
    },
    async ensureInvoice(row) {
      const hit = [...invoices.values()].find((i) => i.order_id === row.order_id);
      if (hit) return { row: clone(hit), created: false };
      const r: InvoiceRow = {
        ...row,
        id: randomUUID(),
        status: "pending",
        invoice_no: null,
        random_number: null,
        invoice_date: null,
        raw: null,
        error: null,
        attempts: 0,
        claimed_at: null,
        issued_at: null,
        voided_at: null,
        allowance_no: null,
        allowance_amount: null,
        created_at: now(),
        updated_at: now(),
      };
      invoices.set(r.id, r);
      return { row: clone(r), created: true };
    },
    async getInvoiceByOrder(tenantId, orderId) {
      return clone([...invoices.values()].find((i) => i.tenant_id === tenantId && i.order_id === orderId) ?? null);
    },
    async claimInvoice(tenantId, id, staleBeforeIso) {
      const i = invoices.get(id);
      if (!i || i.tenant_id !== tenantId) return null;
      const claimable = i.status === "pending" || i.status === "failed" || (i.status === "issuing" && !!i.claimed_at && i.claimed_at < staleBeforeIso);
      if (!claimable) return null;
      const next: InvoiceRow = { ...i, status: "issuing", attempts: i.attempts + 1, claimed_at: now(), updated_at: now() };
      invoices.set(id, next);
      return clone(next);
    },
    async updateInvoice(tenantId, id, from, patch) {
      const i = invoices.get(id);
      if (!i || i.tenant_id !== tenantId || !from.includes(i.status)) return null;
      const next = { ...i, ...clone(patch), updated_at: now() };
      invoices.set(id, next);
      return clone(next);
    },
    async listInvoices(tenantId, opts) {
      return page([...invoices.values()].filter((i) => i.tenant_id === tenantId && (!opts.status || i.status === opts.status)).sort(byNewest), opts.limit, opts.offset);
    },
    async listInvoicesToRetry(limit, maxAttempts) {
      return [...invoices.values()]
        .filter((i) => (i.status === "pending" || i.status === "failed") && i.attempts < maxAttempts)
        .slice(0, limit)
        .map((i) => ({ id: i.id, tenant_id: i.tenant_id }));
    },

    /* -------------------------------------------------------- shipping */
    async getShippingAccount(tenantId) {
      return clone(shipAccounts.get(tenantId) ?? null);
    },
    async upsertShippingAccount(row) {
      const prev = shipAccounts.get(row.tenant_id);
      const next: ShippingAccountRow = { id: prev?.id ?? randomUUID(), created_at: prev?.created_at ?? now(), ...row, status: "unverified", verified_at: null, last_error: null, updated_at: now() };
      shipAccounts.set(row.tenant_id, next);
      return clone(next);
    },
    async markShippingAccount(tenantId, patch) {
      const a = shipAccounts.get(tenantId);
      if (a) shipAccounts.set(tenantId, { ...a, ...patch, updated_at: now() });
    },
    async insertCvsSelection(row) {
      if ([...cvs.values()].some((c) => c.trade_no_hash === row.trade_no_hash)) throw new ServiceError("conflict", "資料重複");
      const r: CvsSelectionRow = { ...row, id: randomUUID(), store: null, selected_at: null, used_at: null, order_id: null, created_at: now() };
      cvs.set(r.id, r);
      return clone(r);
    },
    async setCvsSelectionStore(tradeNoHash, subType, store, nowIso) {
      const r = [...cvs.values()].find((c) => c.trade_no_hash === tradeNoHash);
      if (!r || r.used_at || r.expires_at <= nowIso || r.sub_type !== subType) return null;
      const next = { ...r, store: clone(store), selected_at: nowIso };
      cvs.set(r.id, next);
      return clone(next);
    },
    async getCvsSelection(tenantId, id) {
      const r = cvs.get(id);
      return r && r.tenant_id === tenantId ? clone(r) : null;
    },
    async consumeCvsSelection(tenantId, id, bindingHash, nowIso) {
      const r = cvs.get(id);
      if (!r || r.tenant_id !== tenantId || r.binding_hash !== bindingHash || !r.store || r.used_at || r.expires_at <= nowIso) return null;
      const next = { ...r, used_at: nowIso };
      cvs.set(id, next);
      return clone(next);
    },
    async attachCvsSelectionOrder(tenantId, id, orderId) {
      const r = cvs.get(id);
      if (r && r.tenant_id === tenantId) cvs.set(id, { ...r, order_id: orderId });
    },
    async releaseCvsSelection(tenantId, id) {
      const r = cvs.get(id);
      if (r && r.tenant_id === tenantId && !r.order_id) cvs.set(id, { ...r, used_at: null });
    },
    async insertShipment(row) {
      const active = [...shipments.values()].find((s) => s.order_id === row.order_id && s.status !== "failed" && s.status !== "cancelled");
      if (active && row.status !== "failed" && row.status !== "cancelled") throw new ServiceError("conflict", "這張訂單已經有出貨單了");
      if (row.merchant_trade_no && [...shipments.values()].some((s) => s.merchant_trade_no === row.merchant_trade_no)) throw new ServiceError("conflict", "資料重複");
      const r: ShipmentRow = { ...clone(row), events: clone(row.events ?? []), id: randomUUID(), created_at: now(), updated_at: now() };
      shipments.set(r.id, r);
      return clone(r);
    },
    async getShipmentById(tenantId, id) {
      const s = shipments.get(id);
      return s && s.tenant_id === tenantId ? clone(s) : null;
    },
    async getActiveShipmentByOrder(tenantId, orderId) {
      return clone([...shipments.values()].find((s) => s.tenant_id === tenantId && s.order_id === orderId && s.status !== "failed" && s.status !== "cancelled") ?? null);
    },
    async getShipmentByTradeNo(no) {
      return clone([...shipments.values()].find((s) => s.merchant_trade_no === no) ?? null);
    },
    async updateShipment(tenantId, id, patch) {
      const s = shipments.get(id);
      if (!s || s.tenant_id !== tenantId) throw new Error("shipment not found");
      const next = { ...s, ...clone(patch), updated_at: now() };
      shipments.set(id, next);
      return clone(next);
    },
    async listShipments(tenantId, opts) {
      return page(
        [...shipments.values()].filter((s) => s.tenant_id === tenantId && (!opts.status || s.status === opts.status) && (!opts.orderId || s.order_id === opts.orderId)).sort(byNewest),
        opts.limit,
        opts.offset,
      );
    },

    /* -------------------------------------------------------- referral */
    async getReferralCodeByMember(tenantId, memberId) {
      return clone([...refCodes.values()].find((r) => r.tenant_id === tenantId && r.member_id === memberId) ?? null);
    },
    async getReferralCodeByCode(tenantId, code) {
      return clone([...refCodes.values()].find((r) => r.tenant_id === tenantId && r.code === code) ?? null);
    },
    async insertReferralCode(row) {
      if ([...refCodes.values()].some((r) => r.tenant_id === row.tenant_id && (r.code === row.code || r.member_id === row.member_id))) return null;
      const r: ReferralCodeRow = { ...row, id: randomUUID(), kol_rate_bp: 0, created_at: now() };
      refCodes.set(r.id, r);
      return clone(r);
    },
    async updateReferralCode(tenantId, id, patch) {
      const r = refCodes.get(id);
      if (!r || r.tenant_id !== tenantId) return null;
      const next = { ...r, ...patch };
      refCodes.set(id, next);
      return clone(next);
    },
    async insertReferral(row) {
      if ([...referrals.values()].some((r) => r.tenant_id === row.tenant_id && r.referee_key === row.referee_key)) return null;
      const r: ReferralRow = { ...row, id: randomUUID(), reward_coupon_id: null, created_at: now() };
      referrals.set(r.id, r);
      return clone(r);
    },
    async setReferralReward(tenantId, id, couponId) {
      const r = referrals.get(id);
      if (r && r.tenant_id === tenantId) referrals.set(id, { ...r, reward_coupon_id: couponId });
    },
    async listReferrals(tenantId, opts) {
      return page([...referrals.values()].filter((r) => r.tenant_id === tenantId && (!opts.referrerMemberId || r.referrer_member_id === opts.referrerMemberId)).sort(byNewest), opts.limit, opts.offset);
    },
    async insertLedger(row) {
      if (ledger.some((l) => l.order_id === row.order_id && l.kind === row.kind)) return false;
      ledger.push({ ...row, id: ledger.length + 1, created_at: now() });
      return true;
    },
    async listLedger(tenantId, opts) {
      return clone(
        ledger
          .filter((l) => l.tenant_id === tenantId && (!opts.referrerMemberId || l.referrer_member_id === opts.referrerMemberId) && (!opts.orderId || l.order_id === opts.orderId))
          .slice()
          .reverse()
          .slice(0, opts.limit),
      );
    },

    /* -------------------------------------------------------- newsletter */
    async upsertPendingSubscriber(row) {
      const hit = [...subscribers.values()].find((s) => s.tenant_id === row.tenant_id && s.email === row.email);
      if (hit?.status === "confirmed") return { row: clone(hit), needsConfirm: false };
      const next: SubscriberRow = hit
        ? { ...hit, status: "pending", confirm_token_hash: row.confirm_token_hash, confirm_expires_at: row.confirm_expires_at, unsubscribed_at: null }
        : { ...row, id: randomUUID(), status: "pending", confirmed_at: null, unsubscribed_at: null, created_at: now() };
      subscribers.set(next.id, next);
      return { row: clone(next), needsConfirm: true };
    },
    async confirmSubscriber(tenantId, tokenHash, nowIso) {
      const s = [...subscribers.values()].find((x) => x.tenant_id === tenantId && x.confirm_token_hash === tokenHash);
      if (!s || s.status !== "pending" || !s.confirm_expires_at || s.confirm_expires_at <= nowIso) return null;
      const next: SubscriberRow = { ...s, status: "confirmed", confirmed_at: nowIso, confirm_token_hash: null, confirm_expires_at: null };
      subscribers.set(s.id, next);
      return clone(next);
    },
    async getSubscriberById(tenantId, id) {
      const s = subscribers.get(id);
      return s && s.tenant_id === tenantId ? clone(s) : null;
    },
    async unsubscribeSubscriber(tenantId, id) {
      const s = subscribers.get(id);
      if (!s || s.tenant_id !== tenantId || s.status === "unsubscribed") return false;
      subscribers.set(id, { ...s, status: "unsubscribed", unsubscribed_at: now(), confirm_token_hash: null });
      return true;
    },
    async listSubscribers(tenantId, opts) {
      return page([...subscribers.values()].filter((s) => s.tenant_id === tenantId && (!opts.status || s.status === opts.status)).sort(byNewest), opts.limit, opts.offset);
    },
    async insertBroadcast(row) {
      const b: BroadcastRow = { ...row, id: randomUUID(), status: "draft", test_sent_at: null, started_at: null, finished_at: null, sent_count: 0, failed_count: 0, created_at: now(), updated_at: now() };
      broadcasts.set(b.id, b);
      return clone(b);
    },
    async getBroadcast(tenantId, id) {
      const b = broadcasts.get(id);
      return b && b.tenant_id === tenantId ? clone(b) : null;
    },
    async updateBroadcast(tenantId, id, from, patch) {
      const b = broadcasts.get(id);
      if (!b || b.tenant_id !== tenantId || !from.includes(b.status)) return null;
      const next = { ...b, ...patch, updated_at: now() };
      broadcasts.set(id, next);
      return clone(next);
    },
    async listBroadcasts(tenantId, limit) {
      return clone([...broadcasts.values()].filter((b) => b.tenant_id === tenantId).sort(byNewest).slice(0, limit));
    },
    async queueDeliveries(tenantId, broadcastId, tokenFor) {
      let n = 0;
      for (const s of subscribers.values()) {
        if (s.tenant_id !== tenantId || s.status !== "confirmed") continue;
        if ([...deliveries.values()].some((d) => d.broadcast_id === broadcastId && d.subscriber_id === s.id)) continue;
        const d: DeliveryRow = { id: randomUUID(), tenant_id: tenantId, broadcast_id: broadcastId, subscriber_id: s.id, email: s.email, unsub_token_hash: tokenFor(s.id), status: "queued", error: null, sent_at: null, unsub_used_at: null, created_at: now() };
        deliveries.set(d.id, d);
        n++;
      }
      return n;
    },
    async listQueuedDeliveries(tenantId, broadcastId, limit) {
      return clone([...deliveries.values()].filter((d) => d.tenant_id === tenantId && d.broadcast_id === broadcastId && d.status === "queued").slice(0, limit));
    },
    async finishDelivery(tenantId, id, patch) {
      const d = deliveries.get(id);
      if (!d || d.tenant_id !== tenantId || d.status !== "queued") return false;
      deliveries.set(id, { ...d, ...patch });
      return true;
    },
    async consumeUnsubToken(tenantId, tokenHash) {
      const d = [...deliveries.values()].find((x) => x.tenant_id === tenantId && x.unsub_token_hash === tokenHash);
      if (!d || d.unsub_used_at) return null;
      const next = { ...d, unsub_used_at: now() };
      deliveries.set(d.id, next);
      return clone(next);
    },
    async deliveryStats(tenantId, broadcastId) {
      const out = { queued: 0, sent: 0, failed: 0, skipped: 0 };
      for (const d of deliveries.values()) if (d.tenant_id === tenantId && d.broadcast_id === broadcastId) out[d.status]++;
      return out;
    },

    /* -------------------------------------------------------- ai-chat */
    async getAiChat(tenantId, sessionId) {
      return clone([...chats.values()].find((c) => c.tenant_id === tenantId && c.session_id === sessionId) ?? null);
    },
    async saveAiChat(row) {
      const hit = [...chats.values()].find((c) => c.tenant_id === row.tenant_id && c.session_id === row.session_id);
      const next: AiChatRow = hit ? { ...hit, ...clone(row), updated_at: now() } : { ...clone(row), id: randomUUID(), created_at: now(), updated_at: now() };
      chats.set(next.id, next);
      return clone(next);
    },
    async listAiChats(tenantId, limit) {
      return clone([...chats.values()].filter((c) => c.tenant_id === tenantId).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit));
    },
  } satisfies MemoryExt;
}
