import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { CommerceStore, MemberRow, OrderRow, PaymentAccountRow, PaymentRow, ProductRow, VariantRow } from "./types";



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

export function createSupabaseCommerceStore(db: SupabaseClient): CommerceStore {
  return {
    /* ---------------------------------------------------------- members */
    async insertMember(row) {
      const r = await db.from("builder_members").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertMember") as MemberRow;
    },
    async getMemberByEmail(tenantId, email) {
      return must(await db.from("builder_members").select("*").eq("tenant_id", tenantId).eq("email", email).maybeSingle(), "getMemberByEmail");
    },
    async getMemberById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_members").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getMemberById");
    },
    async updateMember(tenantId, id, patch) {
      return must(await db.from("builder_members").update(patch).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateMember");
    },
    async listMembers(tenantId, opts) {
      let q = db.from("builder_members").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.q) q = q.ilike("email", `%${opts.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listMembers: ${r.error.message}`);
      return { rows: r.data ?? [], total: r.count ?? 0 };
    },
    async insertMemberSession(row) {
      return must(await db.from("builder_member_sessions").insert(row).select("*").single(), "insertMemberSession");
    },
    async getMemberSessionByHash(tokenHash) {
      return must(await db.from("builder_member_sessions").select("*").eq("token_hash", tokenHash).maybeSingle(), "getMemberSessionByHash");
    },
    async revokeMemberSession(tenantId, id) {
      must(await db.from("builder_member_sessions").update({ revoked_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).is("revoked_at", null), "revokeMemberSession");
    },
    async revokeAllMemberSessions(tenantId, memberId) {
      const rows = must(
        await db.from("builder_member_sessions").update({ revoked_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("member_id", memberId).is("revoked_at", null).select("id"),
        "revokeAllMemberSessions",
      ) as { id: string }[];
      return rows.length;
    },
    async insertMemberToken(row) {
      must(await db.from("builder_member_tokens").insert(row), "insertMemberToken");
    },
    async consumeMemberToken(tenantId, tokenHash, purpose, nowIso) {
      // 單一條件更新＝原子：同一個 token 併發消耗只有一個會拿到列
      return must(
        await db
          .from("builder_member_tokens")
          .update({ used_at: nowIso })
          .eq("tenant_id", tenantId)
          .eq("token_hash", tokenHash)
          .eq("purpose", purpose)
          .is("used_at", null)
          .gt("expires_at", nowIso)
          .select("*")
          .maybeSingle(),
        "consumeMemberToken",
      );
    },

    /* ---------------------------------------------------------- products */
    async listProducts(tenantId, opts) {
      let q = db.from("builder_products").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      const r = await q.order("sort").order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listProducts: ${r.error.message}`);
      return { rows: (r.data ?? []) as ProductRow[], total: r.count ?? 0 };
    },
    async getProductById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_products").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getProductById");
    },
    async getProductBySlug(tenantId, slug) {
      return must(await db.from("builder_products").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getProductBySlug");
    },
    async getProductsByIds(tenantId, ids) {
      const valid = ids.filter(isUuid);
      if (!valid.length) return [];
      return (must(await db.from("builder_products").select("*").eq("tenant_id", tenantId).in("id", valid), "getProductsByIds") ?? []) as ProductRow[];
    },
    async insertProduct(row) {
      return must(await db.from("builder_products").insert(row).select("*").single(), "insertProduct") as ProductRow;
    },
    async updateProduct(tenantId, id, patch) {
      return must(
        await db.from("builder_products").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).select("*").single(),
        "updateProduct",
      ) as ProductRow;
    },
    async listVariants(tenantId, productIds) {
      const valid = productIds.filter(isUuid);
      if (!valid.length) return [];
      return (must(await db.from("builder_product_variants").select("*").eq("tenant_id", tenantId).in("product_id", valid).order("sort"), "listVariants") ?? []) as VariantRow[];
    },
    async replaceVariants(tenantId, productId, rows) {
      must(await db.from("builder_product_variants").delete().eq("tenant_id", tenantId).eq("product_id", productId), "replaceVariants.delete");
      if (!rows.length) return [];
      return (must(
        await db
          .from("builder_product_variants")
          .insert(rows.map((r) => ({ ...r, tenant_id: tenantId, product_id: productId })))
          .select("*"),
        "replaceVariants.insert",
      ) ?? []) as VariantRow[];
    },

    /* ---------------------------------------------------------- orders */
    async placeOrder(tenantId, order, items, day) {
      const r = await db.rpc("builder_place_order", { p_tenant: tenantId, p_order: order, p_items: items, p_day: day });
      if (r.error) {
        const m = /insufficient stock: (.*)$/.exec(r.error.message);
        if (m) throw new ServiceError("conflict", `庫存不足或商品已下架：${m[1]}。整筆訂單未成立，請調整數量後再試。`);
        throw new Error(`placeOrder: ${r.error.message}`);
      }
      const row = (r.data as { order_id: string; order_no: string }[])[0];
      if (!row) throw new Error("placeOrder: 沒有回傳");
      return { id: row.order_id, order_no: row.order_no };
    },
    async getOrderById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_orders").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getOrderById") as OrderRow | null;
    },
    async getOrderByNo(tenantId, orderNo) {
      return must(await db.from("builder_orders").select("*").eq("tenant_id", tenantId).eq("order_no", orderNo).maybeSingle(), "getOrderByNo") as OrderRow | null;
    },
    async listOrders(tenantId, opts) {
      let q = db.from("builder_orders").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      if (opts.memberId) q = q.eq("member_id", opts.memberId);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listOrders: ${r.error.message}`);
      return { rows: (r.data ?? []) as OrderRow[], total: r.count ?? 0 };
    },
    async listOrderItems(tenantId, orderId) {
      return must(await db.from("builder_order_items").select("*").eq("tenant_id", tenantId).eq("order_id", orderId), "listOrderItems") ?? [];
    },
    async transitionOrder(tenantId, id, from, to, patch) {
      return must(
        await db
          .from("builder_orders")
          .update({ ...patch, status: to, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .eq("status", from)
          .select("*")
          .maybeSingle(),
        "transitionOrder",
      ) as OrderRow | null;
    },
    async cancelOrder(tenantId, id, from, reason) {
      const rows = must(await db.rpc("builder_cancel_order", { p_tenant: tenantId, p_order: id, p_from: from, p_reason: reason }), "cancelOrder") as {
        transitioned: boolean;
        stock_released: boolean;
      }[];
      return { transitioned: !!rows[0]?.transitioned, stockReleased: !!rows[0]?.stock_released };
    },
    async releaseOrderStock(tenantId, id) {
      return !!must(await db.rpc("builder_release_order_stock", { p_tenant: tenantId, p_order: id }), "releaseOrderStock");
    },
    async listExpiredPendingOrders(nowIso, limit) {
      return must(
        await db.from("builder_orders").select("id, tenant_id").eq("status", "pending_payment").lt("expires_at", nowIso).order("expires_at").limit(limit),
        "listExpiredPendingOrders",
      ) ?? [];
    },

    /* ---------------------------------------------------------- payments */
    async getPaymentAccount(tenantId, provider) {
      return must(await db.from("builder_payment_accounts").select("*").eq("tenant_id", tenantId).eq("provider", provider).maybeSingle(), "getPaymentAccount") as PaymentAccountRow | null;
    },
    async upsertPaymentAccount(row) {
      return must(
        await db
          .from("builder_payment_accounts")
          .upsert({ ...row, status: "unverified", verified_at: null, last_error: null, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,provider" })
          .select("*")
          .single(),
        "upsertPaymentAccount",
      ) as PaymentAccountRow;
    },
    async markPaymentAccount(tenantId, provider, patch) {
      must(await db.from("builder_payment_accounts").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("provider", provider), "markPaymentAccount");
    },
    async insertPayment(row) {
      return must(await db.from("builder_payments").insert(row).select("*").single(), "insertPayment") as PaymentRow;
    },
    async getPaymentByGatewayNo(gatewayOrderNo) {
      return must(await db.from("builder_payments").select("*").eq("gateway_order_no", gatewayOrderNo).maybeSingle(), "getPaymentByGatewayNo") as PaymentRow | null;
    },
    async listPaymentsForOrder(tenantId, orderId) {
      return must(await db.from("builder_payments").select("*").eq("tenant_id", tenantId).eq("order_id", orderId).order("created_at", { ascending: false }), "listPaymentsForOrder") ?? [];
    },
    async updatePayment(tenantId, id, patch) {
      must(await db.from("builder_payments").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id), "updatePayment");
    },
    async transitionPayment(tenantId, id, from, to, patch) {
      const rows = must(
        await db
          .from("builder_payments")
          .update({ ...patch, status: to, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .eq("status", from)
          .select("id"),
        "transitionPayment",
      ) as { id: string }[];
      return rows.length > 0;
    },
  };
}
