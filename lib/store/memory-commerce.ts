import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors";
import { optionsKey } from "./supabase-commerce";
import { normalizeEmail } from "../email-normalize";
import { COUPON_PER_USER, COUPON_UNAVAILABLE } from "./supabase-commerce";
import type {
  CouponRedemptionRow,
  CouponRow,
  MemberRow,
  MemberSessionRow,
  MemberTokenRow,
  OrderItemRow,
  OrderRow,
  PaymentAccountRow,
  PaymentRow,
  ProductRow,
  CommerceStore,
  VariantRow,
  Store,
  ClassReservation,
} from "./types";

/**
 * 課程類訂單的名額預留（由 memory-classes 提供）：reserveSync 在同步區段內檢查＋寫入（不足就丟錯、什麼都不寫），
 * releaseSync 在取消訂單的同一個同步區段內釋放（＝builder_cancel_order 呼叫 builder_release_order_reservations）。
 */
export interface ReservationBridge {
  reserveSync(tenantId: string, orderId: string, res: NonNullable<ClassReservation>): string;
  releaseSync(tenantId: string, orderId: string, cancelReason: string): void;
}

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/**
 * members／shop 的記憶體實作。語意與 Supabase 實作（含 builder_place_order／cancel／release 函式）一致：
 * 每個方法的讀＋寫都在同一個同步區段完成（JS 單執行緒），等同 DB 的原子條件更新。
 */
export function createMemoryCommerceStore(bridge?: ReservationBridge): CommerceStore & Pick<Store, "placeClassOrder"> {
  const members = new Map<string, MemberRow>();
  const sessions = new Map<string, MemberSessionRow>();
  const mtokens = new Map<string, MemberTokenRow>();
  const products = new Map<string, ProductRow>();
  const variants = new Map<string, VariantRow>();
  const orders = new Map<string, OrderRow>();
  const orderItems: OrderItemRow[] = [];
  const counters = new Map<string, number>();
  const accounts = new Map<string, PaymentAccountRow>();
  const payments = new Map<string, PaymentRow>();

  const releaseSync = (tenantId: string, id: string): boolean => {
    const o = orders.get(id);
    if (!o || o.tenant_id !== tenantId || o.stock_released_at) return false;
    orders.set(id, { ...o, stock_released_at: now(), updated_at: now() });
    for (const it of orderItems.filter((i) => i.order_id === id && i.stock_deducted)) {
      if (it.deducted_from === "variant") {
        const v = it.variant_id ? variants.get(it.variant_id) : undefined;
        if (v) variants.set(v.id, { ...v, stock: v.stock + it.qty });
      } else if (it.deducted_from === "product") {
        const p = it.product_id ? products.get(it.product_id) : undefined;
        if (p) products.set(p.id, { ...p, stock: p.stock + it.qty });
      }
    }
    return true;
  };

  const coupons = new Map<string, CouponRow>();
  const redemptions = new Map<string, CouponRedemptionRow>(); // key = order_id
  const userCounts = new Map<string, number>();
  const releaseCouponSync = (tenantId: string, orderId: string): boolean => {
    const r = redemptions.get(orderId);
    if (!r || r.tenant_id !== tenantId || r.released_at) return false;
    redemptions.set(orderId, { ...r, released_at: now() });
    const c = coupons.get(r.coupon_id);
    if (c) coupons.set(c.id, { ...c, used_count: Math.max(0, c.used_count - 1), updated_at: now() });
    const k = `${r.coupon_id}|${r.user_key}`;
    userCounts.set(k, Math.max(0, (userCounts.get(k) ?? 0) - 1));
    return true;
  };

  const store: CommerceStore & Pick<Store, "placeClassOrder"> = {
    async insertCoupon(row) {
      if ([...coupons.values()].some((c) => c.tenant_id === row.tenant_id && c.code === row.code)) throw new ServiceError("conflict", "優惠碼已存在，請換一個");
      const c: CouponRow = { ...clone(row), id: randomUUID(), used_count: 0, created_at: now(), updated_at: now() };
      coupons.set(c.id, c);
      return clone(c);
    },
    async updateCoupon(tenantId, id, patch) {
      const c = coupons.get(id);
      if (!c || c.tenant_id !== tenantId) return null;
      const next = { ...c, ...patch, updated_at: now() };
      coupons.set(id, next);
      return clone(next);
    },
    async getCouponByCode(tenantId, code) {
      return clone([...coupons.values()].find((c) => c.tenant_id === tenantId && c.code === code) ?? null);
    },
    async getCouponById(tenantId, id) {
      const c = coupons.get(id);
      return c && c.tenant_id === tenantId ? clone(c) : null;
    },
    async listCoupons(tenantId, opts) {
      const rows = [...coupons.values()].filter((c) => c.tenant_id === tenantId && (opts.active === undefined || c.active === opts.active)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: clone(rows.slice(opts.offset, opts.offset + opts.limit)), total: rows.length };
    },
    async getCouponUserCount(couponId, userKey) {
      return userCounts.get(`${couponId}|${userKey}`) ?? 0;
    },
    async getRedemptionByOrder(tenantId, orderId) {
      const r = redemptions.get(orderId);
      return r && r.tenant_id === tenantId ? clone(r) : null;
    },
    async releaseCoupon(tenantId, orderId) {
      return releaseCouponSync(tenantId, orderId);
    },
    async setOrderFields(tenantId, orderId, patch) {
      const o = orders.get(orderId);
      if (o && o.tenant_id === tenantId) orders.set(orderId, { ...o, ...patch, updated_at: now() });
    },
    async countPaidOrdersFor(tenantId, who, excludeOrderId) {
      return [...orders.values()].filter(
        (o) => o.tenant_id === tenantId && o.id !== excludeOrderId && (o.status === "paid" || o.status === "fulfilled") && ((who.memberId && o.member_id === who.memberId) || normalizeEmail(o.contact.email) === normalizeEmail(who.email)),
      ).length;
    },
    async insertMember(row) {
      if ([...members.values()].some((m) => m.tenant_id === row.tenant_id && m.email === row.email)) return null;
      const m: MemberRow = { ...row, id: randomUUID(), email_verified_at: null, status: "active", created_at: now(), last_login_at: null };
      members.set(m.id, m);
      return clone(m);
    },
    async getMemberByEmail(tenantId, email) {
      return clone([...members.values()].find((m) => m.tenant_id === tenantId && m.email === email) ?? null);
    },
    async getMemberById(tenantId, id) {
      const m = members.get(id);
      return m && m.tenant_id === tenantId ? clone(m) : null;
    },
    async updateMember(tenantId, id, patch) {
      const m = members.get(id);
      if (!m || m.tenant_id !== tenantId) return null;
      const next = { ...m, ...patch };
      members.set(id, next);
      return clone(next);
    },
    async listMembers(tenantId, opts) {
      const rows = [...members.values()]
        .filter((m) => m.tenant_id === tenantId && (!opts.q || m.email.includes(opts.q.toLowerCase())))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: clone(rows.slice(opts.offset, opts.offset + opts.limit)), total: rows.length };
    },
    async insertMemberSession(row) {
      const s: MemberSessionRow = { ...row, id: randomUUID(), created_at: now(), revoked_at: null };
      sessions.set(s.id, s);
      return clone(s);
    },
    async getMemberSessionByHash(hash) {
      return clone([...sessions.values()].find((s) => s.token_hash === hash) ?? null);
    },
    async revokeMemberSession(tenantId, id) {
      const s = sessions.get(id);
      if (s && s.tenant_id === tenantId && !s.revoked_at) s.revoked_at = now();
    },
    async revokeAllMemberSessions(tenantId, memberId) {
      let n = 0;
      for (const s of sessions.values()) {
        if (s.tenant_id === tenantId && s.member_id === memberId && !s.revoked_at) {
          s.revoked_at = now();
          n++;
        }
      }
      return n;
    },
    async insertMemberToken(row) {
      const t: MemberTokenRow = { ...row, id: randomUUID(), created_at: now(), used_at: null };
      mtokens.set(t.id, t);
    },
    async invalidateMemberTokens(tenantId, memberId, purpose) {
      for (const t of mtokens.values()) if (t.tenant_id === tenantId && t.member_id === memberId && t.purpose === purpose && !t.used_at) t.used_at = now();
    },
    async consumeMemberToken(tenantId, hash, purpose, nowIso) {
      const t = [...mtokens.values()].find((x) => x.token_hash === hash);
      if (!t || t.tenant_id !== tenantId || t.purpose !== purpose || t.used_at || t.expires_at <= nowIso) return null;
      t.used_at = nowIso;
      return clone(t);
    },

    async listProducts(tenantId, opts) {
      const rows = [...products.values()]
        .filter((p) => p.tenant_id === tenantId && (!opts.status || p.status === opts.status))
        .sort((a, b) => a.sort - b.sort || b.created_at.localeCompare(a.created_at));
      return { rows: clone(rows.slice(opts.offset, opts.offset + opts.limit)), total: rows.length };
    },
    async getProductById(tenantId, id) {
      const p = products.get(id);
      return p && p.tenant_id === tenantId ? clone(p) : null;
    },
    async getProductBySlug(tenantId, slug) {
      return clone([...products.values()].find((p) => p.tenant_id === tenantId && p.slug === slug) ?? null);
    },
    async getProductsByIds(tenantId, ids) {
      return clone(ids.map((id) => products.get(id)).filter((p): p is ProductRow => !!p && p.tenant_id === tenantId));
    },
    async insertProduct(row) {
      if ([...products.values()].some((p) => p.tenant_id === row.tenant_id && p.slug === row.slug)) {
        throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      }
      const p: ProductRow = { ...row, id: randomUUID(), created_at: now(), updated_at: now() };
      products.set(p.id, p);
      return clone(p);
    },
    async updateProduct(tenantId, id, patch) {
      const p = products.get(id);
      if (!p || p.tenant_id !== tenantId) throw new Error("product not found");
      if (patch.slug && [...products.values()].some((x) => x.id !== id && x.tenant_id === tenantId && x.slug === patch.slug)) {
        throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
      }
      const next = { ...p, ...patch, updated_at: now() };
      products.set(id, next);
      return clone(next);
    },
    async setProductStockIf(tenantId, id, expected, next) {
      const p = products.get(id);
      if (!p || p.tenant_id !== tenantId || p.stock !== expected) return false;
      products.set(id, { ...p, stock: next, updated_at: now() });
      return true;
    },
    async listVariants(tenantId, productIds) {
      return clone([...variants.values()].filter((v) => v.tenant_id === tenantId && productIds.includes(v.product_id)).sort((a, b) => a.sort - b.sort));
    },
    async replaceVariants(tenantId, productId, rows) {
      const existing = [...variants.values()].filter((v) => v.tenant_id === tenantId && v.product_id === productId);
      const keep = new Set<string>();
      // 先整批檢查 expectedStock（同步區段內＝原子），不符整份不寫
      const matched = new Set<string>();
      for (const r of rows) {
        const hit = existing.find((v) => !matched.has(v.id) && optionsKey(v.options) === optionsKey(r.options));
        if (hit) matched.add(hit.id);
        if (r.stock !== undefined && r.expectedStock !== undefined && (hit?.stock ?? 0) !== r.expectedStock) {
          throw new ServiceError("conflict", `規格「${Object.values(r.options).join(" / ")}」的庫存在你讀取後已變動（目前 ${hit?.stock ?? 0}，你讀到的是 ${r.expectedStock}），請重新讀取後再改`);
        }
      }
      for (const r of rows) {
        const { expectedStock: _e, stock, ...rest } = r;
        const hit = existing.find((v) => !keep.has(v.id) && optionsKey(v.options) === optionsKey(r.options));
        if (hit) {
          keep.add(hit.id);
          variants.set(hit.id, { ...hit, ...rest, stock: stock ?? hit.stock });
        } else {
          const v: VariantRow = { ...rest, stock: stock ?? 0, id: randomUUID(), tenant_id: tenantId, product_id: productId, created_at: now() };
          variants.set(v.id, v);
          keep.add(v.id);
        }
      }
      for (const v of existing) {
        if (keep.has(v.id)) continue;
        variants.delete(v.id);
        // 模擬 FK on delete set null
        for (const it of orderItems) if (it.variant_id === v.id) it.variant_id = null;
      }
      return clone([...variants.values()].filter((v) => v.tenant_id === tenantId && v.product_id === productId).sort((a, b) => a.sort - b.sort));
    },

    async placeOrder(tenantId, order, items, day) {
      // 先全部檢查、再全部扣：等同 SQL 函式「任一不足整筆回滾」
      const plan: { kind: "p" | "v"; id: string; qty: number; track: boolean }[] = [];
      const need = new Map<string, number>();
      for (const it of items) {
        const p = it.product_id ? products.get(it.product_id) : undefined;
        const v = it.variant_id ? variants.get(it.variant_id) : undefined;
        const ok = p && p.tenant_id === tenantId && p.status === "published" && (!it.variant_id || (v && v.product_id === p.id && v.tenant_id === tenantId));
        if (!ok) throw new ServiceError("conflict", `庫存不足或商品已下架：${it.name}。整筆訂單未成立，請調整數量後再試。`);
        const key = it.variant_id ? `v:${it.variant_id}` : `p:${it.product_id}`;
        const total = (need.get(key) ?? 0) + it.qty;
        need.set(key, total);
        const stock = it.variant_id ? v!.stock : p!.stock;
        if (p!.track_inventory && stock < total) throw new ServiceError("conflict", `庫存不足或商品已下架：${it.name}。整筆訂單未成立，請調整數量後再試。`);
        plan.push({ kind: it.variant_id ? "v" : "p", id: it.variant_id ?? p!.id, qty: it.qty, track: p!.track_inventory });
      }
      // 優惠券：與 builder_place_order 同語意（總次數、每人次數、期間、最低消費），檢查都在扣庫存之前（同步區段＝原子）
      const cp = order.coupon ?? null;
      let coupon: CouponRow | undefined;
      if (cp) {
        if (!cp.user_key) throw new Error("builder: coupon user key missing");
        coupon = coupons.get(cp.id);
        const t = Date.now();
        const usable =
          coupon && coupon.tenant_id === tenantId && coupon.active &&
          (!coupon.starts_at || new Date(coupon.starts_at).getTime() <= t) &&
          (!coupon.ends_at || new Date(coupon.ends_at).getTime() > t) &&
          (coupon.max_uses === null || coupon.used_count < coupon.max_uses) &&
          order.subtotal >= coupon.min_subtotal;
        if (!usable) throw new ServiceError("conflict", COUPON_UNAVAILABLE);
        const uc = userCounts.get(`${cp.id}|${cp.user_key}`) ?? 0;
        if (coupon!.per_user_limit !== null && uc >= coupon!.per_user_limit) throw new ServiceError("conflict", COUPON_PER_USER);
      }
      for (const s of plan) {
        if (!s.track) continue;
        if (s.kind === "v") {
          const v = variants.get(s.id)!;
          variants.set(s.id, { ...v, stock: v.stock - s.qty });
        } else {
          const p = products.get(s.id)!;
          products.set(s.id, { ...p, stock: p.stock - s.qty });
        }
      }
      const ck = `${tenantId}|${day}`;
      const n = (counters.get(ck) ?? 0) + 1;
      counters.set(ck, n);
      const orderNo = `${order.order_prefix}-${day}-${String(n).padStart(4, "0")}`;
      const id = randomUUID();
      const row: OrderRow = {
        id,
        tenant_id: tenantId,
        order_no: orderNo,
        member_id: order.member_id,
        contact: clone(order.contact),
        shipping: clone(order.shipping),
        items: clone(items),
        subtotal: order.subtotal,
        shipping_fee: order.shipping_fee,
        total: order.total,
        status: "pending_payment",
        payment_method: order.payment_method,
        paid_at: null,
        fulfilled_at: null,
        cancelled_at: null,
        cancel_reason: null,
        expires_at: order.expires_at,
        stock_released_at: null,
        access_key_hash: order.access_key_hash,
        note: order.note,
        invoice_status: null,
        shipping_method: null,
        shipping_tracking: null,
        payment_sandbox: false,
        discount_total: order.discount_total ?? 0,
        coupon_id: cp?.id ?? null,
        coupon_code: cp?.code ?? null,
        referral_code: order.referral_code || null,
        invoice_request: order.invoice_request ? clone(order.invoice_request) : null,
        shipping_choice: order.shipping_choice ? clone(order.shipping_choice) : null,
        created_at: now(),
        updated_at: now(),
      };
      if (order.shipping_choice?.label) row.shipping_method = order.shipping_choice.label;
      orders.set(id, row);
      if (cp && coupon) {
        coupons.set(cp.id, { ...coupon, used_count: coupon.used_count + 1, updated_at: now() });
        const k = `${cp.id}|${cp.user_key}`;
        userCounts.set(k, (userCounts.get(k) ?? 0) + 1);
        redemptions.set(id, { id: randomUUID(), tenant_id: tenantId, coupon_id: cp.id, order_id: id, user_key: cp.user_key, amount: order.discount_total ?? 0, created_at: now(), released_at: null });
      }
      items.forEach((it, i) =>
        orderItems.push({ ...clone(it), id: randomUUID(), tenant_id: tenantId, order_id: id, stock_deducted: plan[i]!.track, deducted_from: plan[i]!.track ? (it.variant_id ? "variant" : "product") : null }),
      );
      return { id, order_no: orderNo };
    },
    async placeClassOrder(tenantId, order, items, day, res) {
      if (!items.length) throw new Error("builder: empty order");
      // 與 builder_place_class_order 同語意：優惠券先檢查、名額預留（檢查＋寫入）、最後寫訂單——全部在同一個同步區段
      const cp = order.coupon ?? null;
      let coupon: CouponRow | undefined;
      if (cp) {
        if (!cp.user_key) throw new Error("builder: coupon user key missing");
        coupon = coupons.get(cp.id);
        const t = Date.now();
        const usable =
          coupon && coupon.tenant_id === tenantId && coupon.active &&
          (!coupon.starts_at || new Date(coupon.starts_at).getTime() <= t) &&
          (!coupon.ends_at || new Date(coupon.ends_at).getTime() > t) &&
          (coupon.max_uses === null || coupon.used_count < coupon.max_uses) &&
          order.subtotal >= coupon.min_subtotal;
        if (!usable) throw new ServiceError("conflict", COUPON_UNAVAILABLE);
        const uc = userCounts.get(`${cp.id}|${cp.user_key}`) ?? 0;
        if (coupon!.per_user_limit !== null && uc >= coupon!.per_user_limit) throw new ServiceError("conflict", COUPON_PER_USER);
      }
      const id = randomUUID();
      let reservationId: string | null = null;
      if (res) {
        if (!bridge) throw new Error("memory store: 沒有名額預留實作");
        reservationId = bridge.reserveSync(tenantId, id, res);
      }
      const ck = `${tenantId}|${day}`;
      const n = (counters.get(ck) ?? 0) + 1;
      counters.set(ck, n);
      const orderNo = `${order.order_prefix}-${day}-${String(n).padStart(4, "0")}`;
      const snapshot = items.map((it) => ({ product_id: null, variant_id: null, name: it.name, variant_label: it.variant_label, sku: it.sku, unit_price: it.unit_price, qty: it.qty, line_total: it.line_total, item_kind: it.item_kind, ref_id: it.ref_id }));
      const row: OrderRow = {
        id,
        tenant_id: tenantId,
        order_no: orderNo,
        member_id: order.member_id,
        contact: clone(order.contact),
        shipping: clone(order.shipping),
        items: clone(snapshot),
        subtotal: order.subtotal,
        shipping_fee: 0,
        total: order.total,
        status: "pending_payment",
        payment_method: order.payment_method,
        paid_at: null,
        fulfilled_at: null,
        cancelled_at: null,
        cancel_reason: null,
        expires_at: order.expires_at,
        stock_released_at: null,
        access_key_hash: order.access_key_hash,
        note: order.note,
        invoice_status: null,
        shipping_method: null,
        shipping_tracking: null,
        payment_sandbox: false,
        discount_total: order.discount_total ?? 0,
        coupon_id: cp?.id ?? null,
        coupon_code: cp?.code ?? null,
        referral_code: order.referral_code || null,
        invoice_request: order.invoice_request ? clone(order.invoice_request) : null,
        shipping_choice: null,
        created_at: now(),
        updated_at: now(),
      };
      orders.set(id, row);
      if (cp && coupon) {
        coupons.set(cp.id, { ...coupon, used_count: coupon.used_count + 1, updated_at: now() });
        const k = `${cp.id}|${cp.user_key}`;
        userCounts.set(k, (userCounts.get(k) ?? 0) + 1);
        redemptions.set(id, { id: randomUUID(), tenant_id: tenantId, coupon_id: cp.id, order_id: id, user_key: cp.user_key, amount: order.discount_total ?? 0, created_at: now(), released_at: null });
      }
      for (const it of snapshot) orderItems.push({ ...it, id: randomUUID(), tenant_id: tenantId, order_id: id, stock_deducted: false, deducted_from: null });
      return { id, order_no: orderNo, reservation_id: reservationId };
    },
    async getOrderById(tenantId, id) {
      const o = orders.get(id);
      return o && o.tenant_id === tenantId ? clone(o) : null;
    },
    async getOrderByNo(tenantId, orderNo) {
      return clone([...orders.values()].find((o) => o.tenant_id === tenantId && o.order_no === orderNo) ?? null);
    },
    async listOrders(tenantId, opts) {
      const rows = [...orders.values()]
        .filter((o) => o.tenant_id === tenantId && (!opts.status || o.status === opts.status) && (!opts.memberId || o.member_id === opts.memberId))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { rows: clone(rows.slice(opts.offset, opts.offset + opts.limit)), total: rows.length };
    },
    async listOrderItems(tenantId, orderId) {
      return clone(orderItems.filter((i) => i.tenant_id === tenantId && i.order_id === orderId));
    },
    async transitionOrder(tenantId, id, from, to, patch) {
      const o = orders.get(id);
      if (!o || o.tenant_id !== tenantId || o.status !== from) return null;
      const next = { ...o, ...patch, status: to, updated_at: now() };
      orders.set(id, next);
      return clone(next);
    },
    async markPaidSandbox(tenantId, id, paidAt) {
      const o = orders.get(id);
      if (!o || o.tenant_id !== tenantId || o.status !== "pending_payment") return null;
      const next = { ...o, status: "paid" as const, paid_at: paidAt, payment_sandbox: true, updated_at: now() };
      orders.set(id, next);
      bridge?.releaseSync(tenantId, id, "sandbox_payment");
      return clone(next);
    },
    async cancelOrder(tenantId, id, from, reason) {
      const o = orders.get(id);
      if (!o || o.tenant_id !== tenantId || !from.includes(o.status)) return { transitioned: false, stockReleased: false };
      orders.set(id, { ...o, status: "cancelled", cancelled_at: now(), cancel_reason: reason, updated_at: now() });
      const stockReleased = releaseSync(tenantId, id);
      releaseCouponSync(tenantId, id);
      bridge?.releaseSync(tenantId, id, reason);
      return { transitioned: true, stockReleased };
    },
    async releaseOrderStock(tenantId, id) {
      return releaseSync(tenantId, id);
    },
    async listExpiredPendingOrders(nowIso, limit) {
      return [...orders.values()]
        .filter((o) => o.status === "pending_payment" && o.expires_at && o.expires_at < nowIso)
        .slice(0, limit)
        .map((o) => ({ id: o.id, tenant_id: o.tenant_id }));
    },
    async listExpiredPendingOrdersForProducts(tenantId, productIds, nowIso, limit) {
      const ids = new Set(orderItems.filter((i) => i.tenant_id === tenantId && i.product_id !== null && productIds.includes(i.product_id)).map((i) => i.order_id));
      return clone(
        [...orders.values()]
          .filter((o) => o.tenant_id === tenantId && ids.has(o.id) && o.status === "pending_payment" && o.expires_at && o.expires_at < nowIso)
          .slice(0, limit),
      );
    },

    async getPaymentAccount(tenantId, provider) {
      return clone(accounts.get(`${tenantId}|${provider}`) ?? null);
    },
    async upsertPaymentAccount(row) {
      const k = `${row.tenant_id}|${row.provider}`;
      const prev = accounts.get(k);
      const next: PaymentAccountRow = {
        id: prev?.id ?? randomUUID(),
        created_at: prev?.created_at ?? now(),
        ...row,
        status: "unverified",
        verified_at: null,
        last_error: null,
        updated_at: now(),
      };
      accounts.set(k, next);
      return clone(next);
    },
    async markPaymentAccount(tenantId, provider, patch) {
      const k = `${tenantId}|${provider}`;
      const a = accounts.get(k);
      if (a) accounts.set(k, { ...a, ...patch, updated_at: now() });
    },
    async insertPayment(row) {
      if ([...payments.values()].some((p) => p.gateway_order_no === row.gateway_order_no)) throw new ServiceError("conflict", "資料重複");
      const p: PaymentRow = { ...row, id: randomUUID(), status: "pending", payment_url: null, raw: null, paid_at: null, query_failures: 0, last_query_error: null, alerted_at: null, created_at: now(), updated_at: now() };
      payments.set(p.id, p);
      return clone(p);
    },
    async getPaymentByGatewayNo(no) {
      return clone([...payments.values()].find((p) => p.gateway_order_no === no) ?? null);
    },
    async listPaymentsForOrder(tenantId, orderId) {
      return clone([...payments.values()].filter((p) => p.tenant_id === tenantId && p.order_id === orderId));
    },
    async updatePayment(tenantId, id, patch) {
      const p = payments.get(id);
      if (p && p.tenant_id === tenantId) payments.set(id, { ...p, ...patch, updated_at: now() });
    },
    async bumpPaymentQueryFailure(tenantId, id, error) {
      const p = payments.get(id);
      if (!p || p.tenant_id !== tenantId) return 0;
      const n = p.query_failures + 1;
      payments.set(id, { ...p, query_failures: n, last_query_error: error.slice(0, 300), updated_at: now() });
      return n;
    },
    async markPaymentAlerted(tenantId, id) {
      const p = payments.get(id);
      if (!p || p.tenant_id !== tenantId || p.alerted_at) return false;
      payments.set(id, { ...p, alerted_at: now(), updated_at: now() });
      return true;
    },
    async transitionPayment(tenantId, id, from, to, patch) {
      const p = payments.get(id);
      if (!p || p.tenant_id !== tenantId || p.status !== from) return false;
      payments.set(id, { ...p, ...patch, status: to, updated_at: now() });
      return true;
    },
  };
  return store;
}
