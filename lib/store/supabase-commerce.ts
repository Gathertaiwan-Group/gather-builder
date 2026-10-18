import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import { normalizeEmail } from "../email-normalize";
import { mapCreditError } from "./supabase-content";
import type { CommerceStore, CouponRedemptionRow, CouponRow, MemberRow, OrderRow, PaymentAccountRow, PaymentRow, ProductRow, VariantRow } from "./types";



type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}

/** 規格比對鍵：options 依 key 排序後的 JSON */
export const optionsKey = (o: Record<string, string>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

export const COUPON_UNAVAILABLE = "優惠券已用完、已過期、未達最低消費或已停用，訂單未成立，請移除優惠碼後再試。";
export const COUPON_PER_USER = "這張優惠券你已達使用次數上限，訂單未成立。";

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
    async invalidateMemberTokens(tenantId, memberId, purpose) {
      must(
        await db.from("builder_member_tokens").update({ used_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("member_id", memberId).eq("purpose", purpose).is("used_at", null),
        "invalidateMemberTokens",
      );
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
      // 依 options 比對沿用原本的列：未付款訂單的 variant_id 不會因為「只是改價格」而失效
      const existing = (must(await db.from("builder_product_variants").select("*").eq("tenant_id", tenantId).eq("product_id", productId), "replaceVariants.read") ?? []) as VariantRow[];
      const byKey = new Map(existing.map((v) => [optionsKey(v.options), v]));
      // 先整批檢查 expectedStock，不符整份不寫（真正寫入時再以條件更新防競態）
      for (const r of rows) {
        const hit = byKey.get(optionsKey(r.options));
        if (r.stock !== undefined && r.expectedStock !== undefined && (hit?.stock ?? 0) !== r.expectedStock) {
          throw new ServiceError("conflict", `規格「${Object.values(r.options).join(" / ")}」的庫存在你讀取後已變動（目前 ${hit?.stock ?? 0}，你讀到的是 ${r.expectedStock}），請重新讀取後再改`);
        }
      }
      const keep = new Set<string>();
      for (const r of rows) {
        const { expectedStock, stock, ...rest } = r;
        const hit = byKey.get(optionsKey(r.options));
        if (hit && !keep.has(hit.id)) {
          keep.add(hit.id);
          let q = db.from("builder_product_variants").update({ ...rest, ...(stock !== undefined ? { stock } : {}) }).eq("tenant_id", tenantId).eq("id", hit.id);
          if (stock !== undefined && expectedStock !== undefined) q = q.eq("stock", expectedStock);
          const upd = must(await q.select("id"), "replaceVariants.update") as { id: string }[];
          if (!upd.length) throw new ServiceError("conflict", `規格「${Object.values(r.options).join(" / ")}」的庫存剛被訂單扣過，請重新讀取後再改`);
        } else {
          const ins = must(await db.from("builder_product_variants").insert({ ...rest, stock: stock ?? 0, tenant_id: tenantId, product_id: productId }).select("id").single(), "replaceVariants.insert") as { id: string };
          keep.add(ins.id);
        }
      }
      const drop = existing.filter((v) => !keep.has(v.id)).map((v) => v.id);
      if (drop.length) must(await db.from("builder_product_variants").delete().eq("tenant_id", tenantId).in("id", drop), "replaceVariants.delete");
      return (must(await db.from("builder_product_variants").select("*").eq("tenant_id", tenantId).eq("product_id", productId).order("sort"), "replaceVariants.list") ?? []) as VariantRow[];
    },
    async setProductStockIf(tenantId, id, expected, next) {
      const rows = must(
        await db.from("builder_products").update({ stock: next, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).eq("stock", expected).select("id"),
        "setProductStockIf",
      ) as { id: string }[];
      return rows.length > 0;
    },

    /* ---------------------------------------------------------- orders */
    async placeOrder(tenantId, order, items, day) {
      const r = await db.rpc("builder_place_order", { p_tenant: tenantId, p_order: order, p_items: items, p_day: day });
      if (r.error) {
        const m = /insufficient stock: (.*)$/.exec(r.error.message);
        if (m) throw new ServiceError("conflict", `庫存不足或商品已下架：${m[1]}。整筆訂單未成立，請調整數量後再試。`);
        if (/coupon unavailable/.test(r.error.message)) throw new ServiceError("conflict", COUPON_UNAVAILABLE);
        if (/coupon per-user limit/.test(r.error.message)) throw new ServiceError("conflict", COUPON_PER_USER);
        const credit = mapCreditError(r.error.message);
        if (credit) throw credit;
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
    async markPaidSandbox(tenantId, id, paidAt) {
      if (!isUuid(id)) return null;
      const rows = must(await db.rpc("builder_mark_paid_sandbox", { p_tenant: tenantId, p_order: id, p_paid_at: paidAt }), "markPaidSandbox") as OrderRow[] | null;
      return rows?.[0] ?? null;
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

    async listExpiredPendingOrdersForProducts(tenantId, productIds, nowIso, limit) {
      const valid = productIds.filter(isUuid);
      if (!valid.length) return [];
      const items = (must(await db.from("builder_order_items").select("order_id").eq("tenant_id", tenantId).in("product_id", valid).limit(2000), "expiredForProducts.items") ?? []) as { order_id: string }[];
      const ids = [...new Set(items.map((i) => i.order_id))];
      if (!ids.length) return [];
      return (must(
        await db.from("builder_orders").select("*").eq("tenant_id", tenantId).in("id", ids.slice(0, 500)).eq("status", "pending_payment").lt("expires_at", nowIso).order("expires_at").limit(limit),
        "expiredForProducts.orders",
      ) ?? []) as OrderRow[];
    },

    /* ---------------------------------------------------------- coupons */
    async insertCoupon(row) {
      return must(await db.from("builder_coupons").insert(row).select("*").single(), "insertCoupon") as CouponRow;
    },
    async updateCoupon(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_coupons").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateCoupon") as CouponRow | null;
    },
    async getCouponByCode(tenantId, code) {
      return must(await db.from("builder_coupons").select("*").eq("tenant_id", tenantId).eq("code", code).maybeSingle(), "getCouponByCode") as CouponRow | null;
    },
    async getCouponById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_coupons").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getCouponById") as CouponRow | null;
    },
    async listCoupons(tenantId, opts) {
      let q = db.from("builder_coupons").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.active !== undefined) q = q.eq("active", opts.active);
      const r = await q.order("created_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listCoupons: ${r.error.message}`);
      return { rows: (r.data ?? []) as CouponRow[], total: r.count ?? 0 };
    },
    async getCouponUserCount(couponId, userKey) {
      if (!isUuid(couponId)) return 0;
      const r = must(await db.from("builder_coupon_user_counts").select("count").eq("coupon_id", couponId).eq("user_key", userKey).maybeSingle(), "getCouponUserCount") as { count: number } | null;
      return r?.count ?? 0;
    },
    async getRedemptionByOrder(tenantId, orderId) {
      if (!isUuid(orderId)) return null;
      return must(await db.from("builder_coupon_redemptions").select("*").eq("tenant_id", tenantId).eq("order_id", orderId).maybeSingle(), "getRedemptionByOrder") as CouponRedemptionRow | null;
    },
    async setOrderFields(tenantId, orderId, patch) {
      must(await db.from("builder_orders").update({ ...patch, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", orderId), "setOrderFields");
    },
    async countPaidOrdersFor(tenantId, who, excludeOrderId) {
      // L5：用正規化 email 比對（a+x@、gmail 加點視為同一人），SQL 端 builder_norm_email 與 lib/email-normalize.ts 同規則
      const r = await db.rpc("builder_count_paid_orders_for", { p_tenant: tenantId, p_email_norm: normalizeEmail(who.email), p_member: who.memberId && isUuid(who.memberId) ? who.memberId : null, p_exclude: excludeOrderId });
      if (r.error) throw new Error(`countPaidOrdersFor: ${r.error.message}`);
      return Number(r.data ?? 0);
    },
    async releaseCoupon(tenantId, orderId) {
      return !!must(await db.rpc("builder_release_coupon", { p_tenant: tenantId, p_order: orderId }), "releaseCoupon");
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
    async bumpPaymentQueryFailure(tenantId, id, error) {
      // 讀＋寫兩步：失敗次數只用來決定何時警示（警示本身用 markPaymentAlerted 條件更新保證只寄一次）
      const cur = must(await db.from("builder_payments").select("query_failures").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "bumpPaymentQueryFailure.read") as { query_failures: number } | null;
      if (!cur) return 0;
      const n = (cur.query_failures ?? 0) + 1;
      must(await db.from("builder_payments").update({ query_failures: n, last_query_error: error.slice(0, 300), updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id), "bumpPaymentQueryFailure");
      return n;
    },
    async markPaymentAlerted(tenantId, id) {
      const rows = must(
        await db.from("builder_payments").update({ alerted_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).is("alerted_at", null).select("id"),
        "markPaymentAlerted",
      ) as { id: string }[];
      return rows.length > 0;
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
