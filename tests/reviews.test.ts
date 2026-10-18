/**
 * reviews（商品評價，記憶體 Store）：只有付款買家能評價、每訂單每商品一則、審核前不公開、平均分只算公開、
 * 未付款／別人的訂單／沒買這個商品／sandbox 被拒、圖片白名單、回覆與審核要 confirm＋scope、XSS 內文以純文字保存。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { markOrderPaid } from "@/lib/services/orders";
import { createReview, eligibleOrders, listReviews, moderateReview, productReviewSummary, replyReview } from "@/lib/services/reviews";
import type { Actor } from "@/lib/tokens";
import type { MemberRow, Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

async function setup(store: Store, settings: Record<string, unknown> = {}) {
  const s = await makeShop(store, "rv-shop");
  await enableModule(s.ctx, { site: "rv-shop", moduleId: "reviews", config: { imageHosts: ["i.imgur.com"], ...settings } });
  await publishSite(s.ctx, { site: "rv-shop", confirm: true });
  const tenant = (await store.getTenantBySlug("rv-shop"))!;
  const buyer = (await store.insertMember({ tenant_id: tenant.id, email: "buyer@example.com", password_hash: "x", name: "陳大文", phone: null }))!;
  const other = (await store.insertMember({ tenant_id: tenant.id, email: "other@example.com", password_hash: "x", name: "林小美", phone: null }))!;
  return { ...s, tenant, buyer, other };
}
const order = (store: Store, x: Awaited<ReturnType<typeof setup>>, m: MemberRow, productId: string) =>
  placeOrder({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: m, data: { items: [{ productId, qty: 1 }], contact: { name: m.name!, email: m.email, phone: "0912345678" }, shipping: { name: m.name!, phone: "0912345678", address: "台中" }, paymentMethod: "offline" } });

describe("reviews", () => {
  it("只有付款買家能評價、每訂單每商品一則、審核前不公開、平均只算公開", async () => {
    const store = newStore();
    const x = await setup(store);
    const { order: o } = await order(store, x, x.buyer, x.mug.id);
    // 未付款 → 拒絕
    await expect(createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.mug.id, orderId: o.id, rating: 5 } })).rejects.toMatchObject({ code: "forbidden" });
    await markOrderPaid(ctxFor(store), { site: "rv-shop", orderNo: o.order_no, confirm: true });
    expect((await eligibleOrders(store, x.tenant, x.buyer, x.mug.id)).map((v) => v.id)).toEqual([o.id]);
    // 別人拿這張訂單 → 拒絕；沒買的商品 → 拒絕；未登入 → 拒絕
    await expect(createReview(store, { tenant: x.tenant, member: x.other, data: { productId: x.mug.id, orderId: o.id, rating: 1 } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.tee.id, orderId: o.id, rating: 1 } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createReview(store, { tenant: x.tenant, member: null, data: { productId: x.mug.id, orderId: o.id, rating: 1 } })).rejects.toMatchObject({ code: "unauthorized" });
    const r = await createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.mug.id, orderId: o.id, rating: 4, body: "<script>alert(1)</script> 好用" } });
    expect(r).toMatchObject({ status: "pending", display_name: "陳＊文", body: "<script>alert(1)</script> 好用" });
    await expect(createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.mug.id, orderId: o.id, rating: 5 } })).rejects.toMatchObject({ code: "conflict" });
    expect(await eligibleOrders(store, x.tenant, x.buyer, x.mug.id)).toEqual([]);
    // 審核前不公開
    expect(await productReviewSummary(store, x.tenant, x.mug.id)).toMatchObject({ count: 0, average: null, reviews: [] });
    await expect(moderateReview(x.ctx, { site: "rv-shop", reviewId: r.id, action: "publish" })).rejects.toMatchObject({ code: "confirm_required" });
    await moderateReview(x.ctx, { site: "rv-shop", reviewId: r.id, action: "publish", confirm: true });
    await replyReview(x.ctx, { site: "rv-shop", reviewId: r.id, reply: "謝謝支持！", confirm: true });
    expect(await productReviewSummary(store, x.tenant, x.mug.id)).toMatchObject({ count: 1, average: 4, reviews: [{ name: "陳＊文", reply: "謝謝支持！" }] });
    // 第二張訂單 → 可再評一則
    const { order: o2 } = await order(store, x, x.buyer, x.mug.id);
    await markOrderPaid(ctxFor(store), { site: "rv-shop", orderNo: o2.order_no, confirm: true });
    const r2 = await createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.mug.id, orderId: o2.id, rating: 1 } });
    await moderateReview(x.ctx, { site: "rv-shop", reviewId: r2.id, action: "publish", confirm: true });
    expect((await productReviewSummary(store, x.tenant, x.mug.id)).average).toBe(2.5);
    await moderateReview(x.ctx, { site: "rv-shop", reviewId: r2.id, action: "hide", confirm: true });
    expect((await productReviewSummary(store, x.tenant, x.mug.id)).average).toBe(4);
  });

  it("圖片只收白名單網域 https；不審核設定可直接公開；scope", async () => {
    const store = newStore();
    const x = await setup(store, { requireApproval: false });
    const { order: o } = await order(store, x, x.buyer, x.mug.id);
    await markOrderPaid(ctxFor(store), { site: "rv-shop", orderNo: o.order_no, confirm: true });
    for (const bad of ["http://i.imgur.com/a.png", "https://evil.com/a.png", "javascript:alert(1)", "https://user:pw@i.imgur.com/a.png"]) {
      await expect(createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.mug.id, orderId: o.id, rating: 5, images: [bad] } })).rejects.toMatchObject({ code: "invalid" });
    }
    const r = await createReview(store, { tenant: x.tenant, member: x.buyer, data: { productId: x.mug.id, orderId: o.id, rating: 5, images: ["https://i.imgur.com/abc.png"] } });
    expect(r.status).toBe("published");
    const ro: Actor = { kind: "token", tokenId: "t", tenantId: x.tenant.id, scopes: ["site:read"], label: "ro" };
    await expect(moderateReview(ctxFor(store, ro), { reviewId: r.id, action: "hide", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await listReviews(ctxFor(store, ro), {})).reviews[0]).toMatchObject({ reviewer: "陳＊文", status: "published" });
    await configureModule(x.ctx, { site: "rv-shop", moduleId: "reviews", config: { imageHosts: [] } });
  });
});
