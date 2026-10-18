import { z } from "zod";
import type { MemberRow, OrderRow, ReviewRow, Store, TenantRow } from "../store/types";
import type { ReviewsSettings } from "@/modules/reviews/manifest";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { maskName } from "./class-orders";

export async function reviewsActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("reviews");
}
async function requireReviews(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await reviewsActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「reviews」，請先 enable_module reviews");
}
async function settingsFor(store: Store, tenant: TenantRow) {
  return (await publishedModuleSettings(store, tenant, "reviews")) as ReviewsSettings;
}

export const reviewInput = z
  .object({
    productId: z.string().trim().min(1).max(64),
    orderId: z.string().trim().min(1).max(64),
    rating: z.coerce.number().int().min(1, { message: "請選擇 1–5 顆星" }).max(5, { message: "請選擇 1–5 顆星" }),
    body: z.string().trim().max(2000).default(""),
    images: z.array(z.string().trim().max(500)).max(4).default([]),
  })
  .strict();

/** 圖片網址：必須 https、網域在設定的白名單內（不設白名單＝不開放附圖） */
export function allowedImage(url: string, hosts: string[] | undefined): boolean {
  if (!hosts?.length) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => u.hostname === h.toLowerCase()) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** 這位會員可以評價的（訂單, 商品）：本人的訂單、已付款或已出貨、非 sandbox、訂單裡有這個商品、還沒評價過 */
export async function eligibleOrders(store: Store, tenant: TenantRow, member: MemberRow, productId: string): Promise<OrderRow[]> {
  const orders = (await store.listOrders(tenant.id, { memberId: member.id, limit: 100, offset: 0 })).rows.filter((o) => (o.status === "paid" || o.status === "fulfilled") && !o.payment_sandbox && o.items.some((i) => i.product_id === productId));
  if (!orders.length) return [];
  const mine = (await store.listReviews(tenant.id, { memberId: member.id, productId, limit: 200, offset: 0 })).rows;
  return orders.filter((o) => !mine.some((r) => r.order_id === o.id));
}

/**
 * 會員送出評價：🔴 server 端檢查「本人的訂單、已付款／已出貨、訂單有這個商品」；同訂單同商品只一則（DB unique）。
 * 預設 pending（審核後公開）；內文純文字（前台轉義顯示）；圖片只收白名單網域 https。
 */
export async function createReview(store: Store, input: { tenant: TenantRow; member: MemberRow | null; data: unknown }) {
  const { tenant, member } = input;
  if (!(await reviewsActive(store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放評價");
  if (!member || member.status !== "active") throw new ServiceError("unauthorized", "請先登入會員再評價");
  const d = parse(reviewInput, input.data);
  const order = await store.getOrderById(tenant.id, d.orderId);
  if (!order || order.member_id !== member.id || (order.status !== "paid" && order.status !== "fulfilled") || order.payment_sandbox || !order.items.some((i) => i.product_id === d.productId)) {
    throw new ServiceError("forbidden", "只有購買過這個商品、且訂單已付款的會員可以評價");
  }
  const product = await store.getProductById(tenant.id, d.productId);
  if (!product) throw new ServiceError("not_found", "找不到商品");
  const s = await settingsFor(store, tenant);
  const bad = d.images.filter((u) => !allowedImage(u, s.imageHosts));
  if (bad.length) throw new ServiceError("invalid", s.imageHosts?.length ? `圖片只接受這些網域的 https 網址：${s.imageHosts.join("、")}` : "此商店未開放評價附圖");
  const row = await store.insertReview({
    tenant_id: tenant.id,
    product_id: product.id,
    order_id: order.id,
    member_id: member.id,
    display_name: maskName(member.name || order.contact.name || "會員"),
    rating: d.rating,
    body: d.body,
    images: d.images,
    status: s.requireApproval === false ? "published" : "pending",
  });
  await store.insertAudit({ tenant_id: tenant.id, actor: `member:${member.id}`, action: "review.create", payload: { reviewId: row.id, productId: product.id, rating: row.rating, status: row.status } });
  return row;
}

/** 前台：已公開評價＋平均分（只算 published） */
export async function productReviewSummary(store: Store, tenant: TenantRow, productId: string, limit = 20) {
  const all = (await store.listReviews(tenant.id, { productId, status: "published", limit: 500, offset: 0 })).rows;
  const avg = all.length ? Math.round((all.reduce((n, r) => n + r.rating, 0) / all.length) * 10) / 10 : null;
  return { count: all.length, average: avg, reviews: all.slice(0, limit).map((r) => ({ id: r.id, name: r.display_name, rating: r.rating, body: r.body, images: r.images, reply: r.reply, at: r.created_at })) };
}

const summary = (r: ReviewRow) => ({ id: r.id, productId: r.product_id, orderId: r.order_id, reviewer: r.display_name, rating: r.rating, body: r.body, images: r.images, status: r.status, reply: r.reply, createdAt: r.created_at, moderatedAt: r.moderated_at });

export async function listReviews(ctx: ServiceContext, input: { site?: string | null; status?: ReviewRow["status"]; productId?: string; limit?: number; offset?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireReviews(ctx, tenant);
  const r = await ctx.store.listReviews(tenant.id, { status: input.status, productId: input.productId, limit: Math.max(1, Math.min(100, input.limit ?? 30)), offset: Math.max(0, input.offset ?? 0) });
  return { total: r.total, reviews: r.rows.map(summary), note: "評價者姓名已遮罩。pending＝待審核（未公開）。" };
}

export async function moderateReview(ctx: ServiceContext, input: { site?: string | null; reviewId: string; action: "publish" | "hide"; confirm?: boolean }) {
  requireScope(ctx, "reviews:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireReviews(ctx, tenant);
  const r = await ctx.store.getReview(tenant.id, input.reviewId);
  if (!r) throw new ServiceError("not_found", "找不到評價");
  if (input.action !== "publish" && input.action !== "hide") throw new ServiceError("invalid", "action 只能是 publish 或 hide");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `${input.action === "publish" ? "公開" : "隱藏"}這則評價（${r.rating} 星）會立即反映在商品頁。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const row = (await ctx.store.updateReview(tenant.id, r.id, { status: input.action === "publish" ? "published" : "hidden", moderated_by: ctx.actor.label, moderated_at: new Date().toISOString() }))!;
  await audit(ctx, tenant.id, "review.moderate", { reviewId: r.id, action: input.action });
  return summary(row);
}

export async function replyReview(ctx: ServiceContext, input: { site?: string | null; reviewId: string; reply: string; confirm?: boolean }) {
  requireScope(ctx, "reviews:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireReviews(ctx, tenant);
  const r = await ctx.store.getReview(tenant.id, input.reviewId);
  if (!r) throw new ServiceError("not_found", "找不到評價");
  const text = parse(z.string().trim().max(1000), input.reply ?? "");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `${text ? "回覆" : "刪除回覆"}${r.status === "published" ? "會立即顯示在商品頁" : "（評價目前未公開）"}。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const row = (await ctx.store.updateReview(tenant.id, r.id, { reply: text || null, replied_at: text ? new Date().toISOString() : null }))!;
  await audit(ctx, tenant.id, "review.reply", { reviewId: r.id });
  return summary(row);
}
