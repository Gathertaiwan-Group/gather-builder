import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { placeOrder, updateProduct } from "@/lib/services/shop";
import { cancelOrder } from "@/lib/services/orders";
import { createSite } from "@/lib/services/sites";
import { loginMember, registerMember, requestPasswordReset, resetPassword } from "@/lib/services/members";
import { atmExpireDays } from "@/lib/pay/pchomepay";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 3).toString("base64");
});

const contact = { name: "A", email: "a@example.com", phone: "0912345678" };
const shipping = { name: "A", phone: "0912345678", address: "addr" };

describe("審查回饋修正", () => {
  it("M1：只改規格價格時沿用原規格 id，未付款訂單取消會補回同一個規格", async () => {
    const store = newStore();
    const { ctx, tenant, tee } = await makeShop(store, "m1-shop");
    const M = tee.variants.find((v) => v.options["尺寸"] === "M")!;
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: tee.id, variantId: M.id, qty: 2 }], contact, shipping, paymentMethod: "offline" } });
    const r = await updateProduct(ctx, { site: "m1-shop", productId: tee.id, confirm: true, patch: { variants: [{ options: { 尺寸: "M" }, price: 999, stock: 0 }, { options: { 尺寸: "L" }, stock: 1 }] } });
    expect(r.variants.find((v) => v.options["尺寸"] === "M")!.id).toBe(M.id);
    await cancelOrder(ctx, { site: "m1-shop", orderNo: order.order_no, confirm: true });
    expect((await store.listVariants(tenant.id, [tee.id])).find((v) => v.id === M.id)!.stock).toBe(2);
    expect((await store.getProductById(tenant.id, tee.id))!.stock).toBe(0);
  });

  it("M1：規格被刪除後取消，不會把數量誤補到商品層庫存", async () => {
    const store = newStore();
    const { ctx, tenant, tee } = await makeShop(store, "m1b-shop");
    const L = tee.variants.find((v) => v.options["尺寸"] === "L")!;
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: tee.id, variantId: L.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    await updateProduct(ctx, { site: "m1b-shop", productId: tee.id, confirm: true, patch: { variants: [{ options: { 尺寸: "M" }, stock: 2 }] } });
    await cancelOrder(ctx, { site: "m1b-shop", orderNo: order.order_no, confirm: true });
    expect((await store.getProductById(tenant.id, tee.id))!.stock).toBe(0);
  });

  it("M2：帶 expectedStock 時，期間被訂單扣過的庫存不會被蓋回去", async () => {
    const store = newStore();
    const { ctx, tenant, mug } = await makeShop(store, "m2-shop");
    await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: mug.id, qty: 2 }], contact, shipping, paymentMethod: "offline" } });
    await expect(updateProduct(ctx, { site: "m2-shop", productId: mug.id, confirm: true, expectedStock: 5, patch: { stock: 5 } })).rejects.toMatchObject({ code: "conflict" });
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(3);
    await updateProduct(ctx, { site: "m2-shop", productId: mug.id, confirm: true, patch: { price: 400 } });
    expect((await store.getProductById(tenant.id, mug.id))!.stock).toBe(3);
  });

  it("M6：ATM 繳費期限一定短於訂單保留時間", () => {
    expect(atmExpireDays(24)).toBeNull();
    expect(atmExpireDays(47)).toBeNull();
    expect(atmExpireDays(48)).toBe(1);
    expect(atmExpireDays(72)).toBe(2);
    expect(atmExpireDays(168)).toBe(5);
    for (const h of [48, 60, 72, 100, 168]) expect(atmExpireDays(h)! * 24).toBeLessThan(h);
  });

  it("L1：重設成功後，較早寄出的其他重設連結一併失效", async () => {
    const store = newStore();
    const mails: string[] = [];
    const deps = { store, ipSecret: "x-secret-xxxxx", baseUrl: "http://t", sendMail: async (_to: string, _s: string, text: string) => void mails.push(text) };
    await createSite(ctxFor(store), { slug: "l1-site", name: "L1", modules: ["members"] });
    const t = (await store.getTenantBySlug("l1-site"))!;
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "l1@example.com", password: "password-123" } });
    await requestPasswordReset(deps, { tenant: t, ip: "1.1.1.1", email: "l1@example.com" });
    await requestPasswordReset(deps, { tenant: t, ip: "1.1.1.1", email: "l1@example.com" });
    const [older, newer] = mails.slice(-2).map((m) => /token=([A-Za-z0-9_-]+)/.exec(m)![1]!);
    await resetPassword(deps, { tenant: t, ip: "1.1.1.1", token: newer, password: "new-password" });
    await expect(resetPassword(deps, { tenant: t, ip: "1.1.1.1", token: older, password: "attacker-pw" })).rejects.toMatchObject({ code: "invalid" });
    await expect(loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "l1@example.com", password: "new-password" })).resolves.toBeTruthy();
  });

  it("L4：訂單金額上限", async () => {
    const store = newStore();
    const { ctx, tenant } = await makeShop(store, "l4-shop");
    const { createProduct } = await import("@/lib/services/shop");
    const big = await createProduct(ctx, { site: "l4-shop", slug: "big", name: "很貴", price: 9_000_000, status: "published", confirm: true });
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: big.id, qty: 99 }], contact, shipping, paymentMethod: "offline" } })).rejects.toThrow(/上限/);
  });
});
