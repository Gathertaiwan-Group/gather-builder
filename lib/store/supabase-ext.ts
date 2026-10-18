import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { ExtImpl } from "./memory-ext";
import type {
  AiChatRow,
  BroadcastRow,
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

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);
const nowIso = () => new Date().toISOString();

/** 第三批模組的 Supabase 實作（service role；所有查詢都帶 tenant_id） */
export function createSupabaseExtStore(db: SupabaseClient): ExtImpl {
  return {
    /* -------------------------------------------------------- invoice */
    async getInvoiceAccount(tenantId) {
      return must(await db.from("builder_invoice_accounts").select("*").eq("tenant_id", tenantId).maybeSingle(), "getInvoiceAccount") as InvoiceAccountRow | null;
    },
    async upsertInvoiceAccount(row) {
      return must(
        await db
          .from("builder_invoice_accounts")
          .upsert({ ...row, status: "unverified", verified_at: null, last_error: null, updated_at: nowIso() }, { onConflict: "tenant_id" })
          .select("*")
          .single(),
        "upsertInvoiceAccount",
      ) as InvoiceAccountRow;
    },
    async markInvoiceAccount(tenantId, patch) {
      must(await db.from("builder_invoice_accounts").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId), "markInvoiceAccount");
    },
    async ensureInvoice(row) {
      // insert … on conflict (order_id) do nothing：同一訂單重複觸發只會有一列
      const ins = await db.from("builder_invoices").upsert(row, { onConflict: "order_id", ignoreDuplicates: true }).select("*");
      const inserted = must(ins, "ensureInvoice") as InvoiceRow[];
      if (inserted.length) return { row: inserted[0]!, created: true };
      const hit = must(await db.from("builder_invoices").select("*").eq("order_id", row.order_id).single(), "ensureInvoice.read") as InvoiceRow;
      return { row: hit, created: false };
    },
    async getInvoiceByOrder(tenantId, orderId) {
      if (!isUuid(orderId)) return null;
      return must(await db.from("builder_invoices").select("*").eq("tenant_id", tenantId).eq("order_id", orderId).maybeSingle(), "getInvoiceByOrder") as InvoiceRow | null;
    },
    async claimInvoice(tenantId, id, staleBeforeIso) {
      const cur = must(await db.from("builder_invoices").select("attempts").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "claimInvoice.read") as { attempts: number } | null;
      if (!cur) return null;
      // 條件式宣告：attempts 也放進條件，兩個併發宣告只有一個會更新到列
      const r = await db
        .from("builder_invoices")
        .update({ status: "issuing", attempts: cur.attempts + 1, claimed_at: nowIso(), updated_at: nowIso() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .eq("attempts", cur.attempts)
        .or(`status.in.(pending,failed),and(status.eq.issuing,claimed_at.lt."${staleBeforeIso}")`)
        .select("*")
        .maybeSingle();
      return must(r, "claimInvoice") as InvoiceRow | null;
    },
    async updateInvoice(tenantId, id, from, patch) {
      return must(
        await db.from("builder_invoices").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from).select("*").maybeSingle(),
        "updateInvoice",
      ) as InvoiceRow | null;
    },
    async listInvoices(tenantId, opts) {
      let q = db.from("builder_invoices").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listInvoices: ${r.error.message}`);
      return { rows: (r.data ?? []) as InvoiceRow[], total: r.count ?? 0 };
    },
    async listInvoicesToRetry(limit, maxAttempts) {
      return (must(await db.from("builder_invoices").select("id, tenant_id, order_id").in("status", ["pending", "failed"]).lt("attempts", maxAttempts).order("updated_at").limit(limit), "listInvoicesToRetry") ?? []) as Pick<InvoiceRow, "id" | "tenant_id" | "order_id">[];
    },

    /* -------------------------------------------------------- shipping */
    async getShippingAccount(tenantId) {
      return must(await db.from("builder_shipping_accounts").select("*").eq("tenant_id", tenantId).maybeSingle(), "getShippingAccount") as ShippingAccountRow | null;
    },
    async upsertShippingAccount(row) {
      return must(
        await db
          .from("builder_shipping_accounts")
          .upsert({ ...row, status: "unverified", verified_at: null, last_error: null, updated_at: nowIso() }, { onConflict: "tenant_id" })
          .select("*")
          .single(),
        "upsertShippingAccount",
      ) as ShippingAccountRow;
    },
    async markShippingAccount(tenantId, patch) {
      must(await db.from("builder_shipping_accounts").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId), "markShippingAccount");
    },
    async insertCvsSelection(row) {
      return must(await db.from("builder_cvs_selections").insert(row).select("*").single(), "insertCvsSelection") as CvsSelectionRow;
    },
    async setCvsSelectionStore(tradeNoHash, subType, store, now) {
      return must(
        await db
          .from("builder_cvs_selections")
          .update({ store, selected_at: now })
          .eq("trade_no_hash", tradeNoHash)
          .eq("sub_type", subType)
          .is("used_at", null)
          .gt("expires_at", now)
          .select("*")
          .maybeSingle(),
        "setCvsSelectionStore",
      ) as CvsSelectionRow | null;
    },
    async getCvsSelection(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_cvs_selections").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getCvsSelection") as CvsSelectionRow | null;
    },
    async consumeCvsSelection(tenantId, id, bindingHash, now) {
      if (!isUuid(id)) return null;
      return must(
        await db
          .from("builder_cvs_selections")
          .update({ used_at: now })
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .eq("binding_hash", bindingHash)
          .not("store", "is", null)
          .is("used_at", null)
          .gt("expires_at", now)
          .select("*")
          .maybeSingle(),
        "consumeCvsSelection",
      ) as CvsSelectionRow | null;
    },
    async attachCvsSelectionOrder(tenantId, id, orderId) {
      must(await db.from("builder_cvs_selections").update({ order_id: orderId }).eq("tenant_id", tenantId).eq("id", id), "attachCvsSelectionOrder");
    },
    async releaseCvsSelection(tenantId, id) {
      must(await db.from("builder_cvs_selections").update({ used_at: null }).eq("tenant_id", tenantId).eq("id", id).is("order_id", null), "releaseCvsSelection");
    },
    async insertShipment(row) {
      const r = await db.from("builder_shipments").insert({ ...row, events: row.events ?? [] }).select("*").single();
      if (r.error?.code === "23505") throw new ServiceError("conflict", "這張訂單已經有出貨單了");
      return must(r, "insertShipment") as ShipmentRow;
    },
    async getShipmentById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_shipments").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getShipmentById") as ShipmentRow | null;
    },
    async getActiveShipmentByOrder(tenantId, orderId) {
      if (!isUuid(orderId)) return null;
      return must(
        await db.from("builder_shipments").select("*").eq("tenant_id", tenantId).eq("order_id", orderId).not("status", "in", "(failed,cancelled)").maybeSingle(),
        "getActiveShipmentByOrder",
      ) as ShipmentRow | null;
    },
    async getShipmentByTradeNo(no) {
      return must(await db.from("builder_shipments").select("*").eq("merchant_trade_no", no).maybeSingle(), "getShipmentByTradeNo") as ShipmentRow | null;
    },
    async updateShipment(tenantId, id, patch) {
      return must(await db.from("builder_shipments").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").single(), "updateShipment") as ShipmentRow;
    },
    async listShipments(tenantId, opts) {
      let q = db.from("builder_shipments").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.orderId && isUuid(opts.orderId)) q = q.eq("order_id", opts.orderId);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listShipments: ${r.error.message}`);
      return { rows: (r.data ?? []) as ShipmentRow[], total: r.count ?? 0 };
    },

    /* -------------------------------------------------------- referral */
    async getReferralCodeByMember(tenantId, memberId) {
      if (!isUuid(memberId)) return null;
      return must(await db.from("builder_referral_codes").select("*").eq("tenant_id", tenantId).eq("member_id", memberId).maybeSingle(), "getReferralCodeByMember") as ReferralCodeRow | null;
    },
    async getReferralCodeByCode(tenantId, code) {
      return must(await db.from("builder_referral_codes").select("*").eq("tenant_id", tenantId).eq("code", code).maybeSingle(), "getReferralCodeByCode") as ReferralCodeRow | null;
    },
    async insertReferralCode(row) {
      const r = await db.from("builder_referral_codes").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertReferralCode") as ReferralCodeRow;
    },
    async updateReferralCode(tenantId, id, patch) {
      return must(await db.from("builder_referral_codes").update(patch).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateReferralCode") as ReferralCodeRow | null;
    },
    async insertReferral(row) {
      const r = await db.from("builder_referrals").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertReferral") as ReferralRow;
    },
    async setReferralReward(tenantId, id, couponId) {
      must(await db.from("builder_referrals").update({ reward_coupon_id: couponId }).eq("tenant_id", tenantId).eq("id", id), "setReferralReward");
    },
    async listReferrals(tenantId, opts) {
      let q = db.from("builder_referrals").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.referrerMemberId) q = q.eq("referrer_member_id", opts.referrerMemberId);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listReferrals: ${r.error.message}`);
      return { rows: (r.data ?? []) as ReferralRow[], total: r.count ?? 0 };
    },
    async insertLedger(row) {
      const r = await db.from("builder_referral_ledger").insert(row);
      if (r.error?.code === "23505") return false;
      must(r, "insertLedger");
      return true;
    },
    async listLedger(tenantId, opts) {
      let q = db.from("builder_referral_ledger").select("*").eq("tenant_id", tenantId);
      if (opts.referrerMemberId) q = q.eq("referrer_member_id", opts.referrerMemberId);
      if (opts.orderId) q = q.eq("order_id", opts.orderId);
      return (must(await q.order("id", { ascending: false }).limit(opts.limit), "listLedger") ?? []) as ReferralLedgerRow[];
    },

    /* -------------------------------------------------------- newsletter */
    async upsertPendingSubscriber(row) {
      const cur = must(await db.from("builder_newsletter_subscribers").select("*").eq("tenant_id", row.tenant_id).eq("email", row.email).maybeSingle(), "upsertPendingSubscriber.read") as SubscriberRow | null;
      if (cur?.status === "confirmed") return { row: cur, needsConfirm: false };
      if (cur) {
        const upd = must(
          await db
            .from("builder_newsletter_subscribers")
            .update({ status: "pending", confirm_token_hash: row.confirm_token_hash, confirm_expires_at: row.confirm_expires_at, unsubscribed_at: null })
            .eq("tenant_id", row.tenant_id)
            .eq("id", cur.id)
            .neq("status", "confirmed")
            .select("*")
            .maybeSingle(),
          "upsertPendingSubscriber.update",
        ) as SubscriberRow | null;
        return upd ? { row: upd, needsConfirm: true } : { row: cur, needsConfirm: false };
      }
      const ins = await db.from("builder_newsletter_subscribers").insert({ ...row, status: "pending" }).select("*").single();
      if (ins.error?.code === "23505") {
        const again = must(await db.from("builder_newsletter_subscribers").select("*").eq("tenant_id", row.tenant_id).eq("email", row.email).single(), "upsertPendingSubscriber.reread") as SubscriberRow;
        return { row: again, needsConfirm: false };
      }
      return { row: must(ins, "upsertPendingSubscriber.insert") as SubscriberRow, needsConfirm: true };
    },
    async confirmSubscriber(tenantId, tokenHash, now) {
      return must(
        await db
          .from("builder_newsletter_subscribers")
          .update({ status: "confirmed", confirmed_at: now, confirm_token_hash: null, confirm_expires_at: null })
          .eq("tenant_id", tenantId)
          .eq("confirm_token_hash", tokenHash)
          .eq("status", "pending")
          .gt("confirm_expires_at", now)
          .select("*")
          .maybeSingle(),
        "confirmSubscriber",
      ) as SubscriberRow | null;
    },
    async getSubscriberById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_newsletter_subscribers").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getSubscriberById") as SubscriberRow | null;
    },
    async unsubscribeSubscriber(tenantId, id) {
      const rows = must(
        await db.from("builder_newsletter_subscribers").update({ status: "unsubscribed", unsubscribed_at: nowIso(), confirm_token_hash: null }).eq("tenant_id", tenantId).eq("id", id).neq("status", "unsubscribed").select("id"),
        "unsubscribeSubscriber",
      ) as { id: string }[];
      return rows.length > 0;
    },
    async listSubscribers(tenantId, opts) {
      let q = db.from("builder_newsletter_subscribers").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listSubscribers: ${r.error.message}`);
      return { rows: (r.data ?? []) as SubscriberRow[], total: r.count ?? 0 };
    },
    async insertBroadcast(row) {
      return must(await db.from("builder_newsletter_broadcasts").insert(row).select("*").single(), "insertBroadcast") as BroadcastRow;
    },
    async getBroadcast(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_newsletter_broadcasts").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getBroadcast") as BroadcastRow | null;
    },
    async updateBroadcast(tenantId, id, from, patch) {
      return must(
        await db.from("builder_newsletter_broadcasts").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).in("status", from).select("*").maybeSingle(),
        "updateBroadcast",
      ) as BroadcastRow | null;
    },
    async listBroadcasts(tenantId, limit) {
      return (must(await db.from("builder_newsletter_broadcasts").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(limit), "listBroadcasts") ?? []) as BroadcastRow[];
    },
    async queueDeliveries(tenantId, broadcastId, tokenFor) {
      let total = 0;
      for (let from = 0; ; from += 1000) {
        const subs = (must(
          await db.from("builder_newsletter_subscribers").select("id").eq("tenant_id", tenantId).eq("status", "confirmed").order("created_at").range(from, from + 999),
          "queueDeliveries.subs",
        ) ?? []) as { id: string }[];
        if (!subs.length) break;
        const rows = subs.map((s) => ({ subscriber_id: s.id, token_hash: tokenFor(s.id) }));
        total += Number(must(await db.rpc("builder_queue_deliveries", { p_tenant: tenantId, p_broadcast: broadcastId, p_rows: rows }), "queueDeliveries") ?? 0);
        if (subs.length < 1000) break;
      }
      return total;
    },
    async listQueuedDeliveries(tenantId, broadcastId, limit) {
      return (must(await db.from("builder_newsletter_deliveries").select("*").eq("tenant_id", tenantId).eq("broadcast_id", broadcastId).eq("status", "queued").order("created_at").limit(limit), "listQueuedDeliveries") ?? []) as DeliveryRow[];
    },
    async finishDelivery(tenantId, id, patch) {
      const rows = must(await db.from("builder_newsletter_deliveries").update(patch).eq("tenant_id", tenantId).eq("id", id).eq("status", "queued").select("id"), "finishDelivery") as { id: string }[];
      return rows.length > 0;
    },
    async consumeUnsubToken(tenantId, tokenHash) {
      return must(
        await db.from("builder_newsletter_deliveries").update({ unsub_used_at: nowIso() }).eq("tenant_id", tenantId).eq("unsub_token_hash", tokenHash).is("unsub_used_at", null).select("*").maybeSingle(),
        "consumeUnsubToken",
      ) as DeliveryRow | null;
    },
    async deliveryStats(tenantId, broadcastId) {
      const out = { queued: 0, sent: 0, failed: 0, skipped: 0 };
      for (const st of Object.keys(out) as (keyof typeof out)[]) {
        const r = await db.from("builder_newsletter_deliveries").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("broadcast_id", broadcastId).eq("status", st);
        if (r.error) throw new Error(`deliveryStats: ${r.error.message}`);
        out[st] = r.count ?? 0;
      }
      return out;
    },

    /* -------------------------------------------------------- ai-chat */
    async getAiChat(tenantId, sessionId) {
      return must(await db.from("builder_ai_chats").select("*").eq("tenant_id", tenantId).eq("session_id", sessionId).maybeSingle(), "getAiChat") as AiChatRow | null;
    },
    async saveAiChat(row) {
      return must(await db.from("builder_ai_chats").upsert({ ...row, updated_at: nowIso() }, { onConflict: "tenant_id,session_id" }).select("*").single(), "saveAiChat") as AiChatRow;
    },
    async listAiChats(tenantId, limit) {
      return (must(await db.from("builder_ai_chats").select("*").eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(limit), "listAiChats") ?? []) as AiChatRow[];
    },
  };
}
