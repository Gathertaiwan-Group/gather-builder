/**
 * coupons 模組：server 計價、百分比上限、最低消費、期間、總次數與每人次數（含併發）、取消回補冪等。
 * 記憶體 Store 與 builder_place_order 同語意；真 DB 的併發另見 tests/integration/modules.test.ts。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, expireIfDue } from "@/lib/services/orders";
import { couponDiscount, createCoupon, listCoupons, updateCoupon } from "@/lib/services/coupons";
import { handleQuote } from "@/lib/shop-routes";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 6).toString("base64");
});

const shipping = { name: "客人", phone: "0912345678", address: "台中市" };
const contact = (email = "buyer@example.com") => ({ name: "客人", email, phone: "0912345678" });

async function couponShop(store: Store, slug: string) {
  const shop = await makeShop(store, slug, { maxQtyPerItem: 50 });
  await enableModule(ctxFor(store), { site: slug, moduleId: "coupons" });
  return shop;
}
const order = (store: Store, shop: Awaited<ReturnType<typeof couponShop>>, code: string | undefined, qty = 1, email?: string) =>
  placeOrder({ store, baseUrl: "http://t" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty }], contact: contact(email), shipping, paymentMethod: "offline", couponCode: code } });

describe("折扣計算", () => {
  it("固定金額不超過小計；百分比無條件捨去且受上限限制", () => {
    expect(couponDiscount({ kind: "fixed", value: 100, max_discount: null }, 350)).toBe(100);
    expect(couponDiscount({ kind: "fixed", value: 500, max_discount: null }, 350)).toBe(350);
    expect(couponDiscount({ kind: "percent", value: 15, max_discount: 1000 }, 350)).toBe(52);
    expect(couponDiscount({ kind: "percent", value: 50, max_discount: 100 }, 1000)).toBe(100);
    expect(couponDiscount({ kind: "percent", value: 100, max_discount: 99999 }, 300)).toBe(300);
  });

  it("百分比券一定要有上限、1–100；需要 marketing:write", async () => {
    const store = newStore();
    const s = await couponShop(store, "cp-create");
    await expect(createCoupon(s.ctx, { site: "cp-create", code: "P10", kind: "percent", value: 10 })).rejects.toThrow(/maxDiscount/);
    await expect(createCoupon(s.ctx, { site: "cp-create", code: "P200", kind: "percent", value: 200, maxDiscount: 100 })).rejects.toThrow(/1–100/);
    const ro = ctxFor(store, { kind: "token", label: "t", tenantId: s.tenant.id, scopes: ["site:read", "commerce:write"] });
    await expect(createCoupon(ro, { code: "X100", kind: "fixed", value: 100 })).rejects.toMatchObject({ code: "forbidden" });
    await createCoupon(s.ctx, { site: "cp-create", code: "save100", kind: "fixed", value: 100 });
    await expect(createCoupon(s.ctx, { site: "cp-create", code: "SAVE100", kind: "fixed", value: 50 })).rejects.toMatchObject({ code: "conflict" });
    expect((await listCoupons(ro, {})).coupons[0]).toMatchObject({ code: "SAVE100", usedCount: 0 });
  });
});

describe("結帳套用（server 計價）", () => {
  it("套用後金額正確；quote 與下單同一套；前端送的折扣無效", async () => {
    const store = newStore();
    const s = await couponShop(store, "cp-apply");
    await createCoupon(s.ctx, { site: "cp-apply", code: "OFF15", kind: "percent", value: 15, maxDiscount: 200 });
    const q = await handleQuote(new Request("http://t/q", { method: "POST", body: JSON.stringify({ items: [{ productId: s.mug.id, qty: 2 }], couponCode: "off15", discount: 9999 }) }), "cp-apply", store);
    expect(await q.json()).toMatchObject({ subtotal: 700, shippingFee: 80, discount: 105, total: 675, couponMessage: "已套用 OFF15" });
    const r = await order(store, s, "off15", 2);
    expect(r.order).toMatchObject({ subtotal: 700, shipping_fee: 80, discount_total: 105, total: 675, coupon_code: "OFF15" });
    expect((await store.getCouponByCode(s.tenant.id, "OFF15"))!.used_count).toBe(1);
    await expect(order(store, s, "NOPE")).rejects.toThrow(/折扣碼無法使用/);
  });

  it("最低消費、尚未開始、已過期、已停用", async () => {
    const store = newStore();
    const s = await couponShop(store, "cp-rules");
    await createCoupon(s.ctx, { site: "cp-rules", code: "MIN1000", kind: "fixed", value: 100, minSubtotal: 1000 });
    await createCoupon(s.ctx, { site: "cp-rules", code: "LATER", kind: "fixed", value: 100, startsAt: new Date(Date.now() + 86400_000).toISOString() });
    await createCoupon(s.ctx, { site: "cp-rules", code: "OLD", kind: "fixed", value: 100, startsAt: new Date(Date.now() - 2 * 86400_000).toISOString(), endsAt: new Date(Date.now() - 86400_000).toISOString() });
    await createCoupon(s.ctx, { site: "cp-rules", code: "OFFNOW", kind: "fixed", value: 100 });
    await updateCoupon(s.ctx, { site: "cp-rules", code: "OFFNOW", active: false });
    await expect(order(store, s, "MIN1000", 1)).rejects.toThrow(/最低消費/);
    await expect(order(store, s, "LATER")).rejects.toThrow(/尚未開始/);
    await expect(order(store, s, "OLD")).rejects.toThrow(/已過期/);
    await expect(order(store, s, "OFFNOW")).rejects.toThrow(/無效/);
    expect((await order(store, s, "MIN1000", 3)).order.discount_total).toBe(100);
  });

  it("總次數上限：併發下單不超用", async () => {
    const store = newStore();
    const s = await couponShop(store, "cp-race");
    await createCoupon(s.ctx, { site: "cp-race", code: "TWO", kind: "fixed", value: 50, maxUses: 2 });
    const r = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => order(store, s, "TWO", 1, `u${i}@example.com`)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect((await store.getCouponByCode(s.tenant.id, "TWO"))!.used_count).toBe(2);
  });

  it("每人上限（同 email／同會員）；取消回補且冪等（重複取消、逾期不會多補）", async () => {
    const store = newStore();
    const s = await couponShop(store, "cp-user");
    await createCoupon(s.ctx, { site: "cp-user", code: "ONCE", kind: "fixed", value: 30, perUserLimit: 1, maxUses: 10 });
    const first = await order(store, s, "ONCE", 1, "same@example.com");
    await expect(order(store, s, "ONCE", 1, "same@example.com")).rejects.toThrow(/使用次數上限/);
    await order(store, s, "ONCE", 1, "other@example.com");
    expect((await store.getCouponByCode(s.tenant.id, "ONCE"))!.used_count).toBe(2);
    await cancelOrder(s.ctx, { site: "cp-user", orderNo: first.order.order_no, confirm: true });
    expect(await store.releaseCoupon(s.tenant.id, first.order.id)).toBe(false); // 已回補過
    expect((await store.getCouponByCode(s.tenant.id, "ONCE"))!.used_count).toBe(1);
    // 回補後同一個人可以再用
    const again = await order(store, s, "ONCE", 1, "same@example.com");
    // 逾期取消也會回補（只一次）
    const later = Date.now() + 10 * 86400_000;
    await expireIfDue(store, again.order, later);
    await expireIfDue(store, (await store.getOrderById(s.tenant.id, again.order.id))!, later);
    expect((await store.getCouponByCode(s.tenant.id, "ONCE"))!.used_count).toBe(1);
  });

  it("沒啟用 coupons 模組不能用折扣碼", async () => {
    const store = newStore();
    const s = await makeShop(store, "cp-off");
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact: contact(), shipping, paymentMethod: "offline", couponCode: "ANY" } })).rejects.toThrow(/未開放折扣碼/);
  });
});
