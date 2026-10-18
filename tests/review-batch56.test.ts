/**
 * 第五六批獨立審查修正（記憶體 Store）：M1 儲值入帳讀下單快照、M2 取消已入帳儲值訂單先試算、
 * L1 sandbox 付款同交易退回點數／儲值金／優惠券、L2 sandbox 取消側 hook 失敗仍可補做、L3 公開頁補做不計次。
 * H1／M3／M4／M5／M6／L5／L6 的測試分別在 loyalty／wallet／referral／certificates／review-batch4／i18n／invoice 測試檔。
 * 真 DB：tests/integration/loyalty-wallet.test.ts（H1 SQL＝TS）、tests/integration/review-batch56.test.ts。🔴 假寄信、mock 金流。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, getOrder, handlePchomepayNotify, markOrderPaid, retryOrderHooks, savePaymentAccount, startPchomepayPayment } from "@/lib/services/orders";
import { adjustPoints } from "@/lib/services/loyalty";
import { buyTopup, createTopupPlan, onWalletOrderPaid, updateTopupPlan } from "@/lib/services/wallet";
import { createCoupon } from "@/lib/services/coupons";
import { registerOrderHooks } from "@/lib/services/order-hooks";
import type { PchomepayClient, PchomepayQuery } from "@/lib/pay/pchomepay";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 5).toString("base64");
});

const contact = { name: "會員", email: "m@example.com", phone: "0912345678" };
const shipping = { name: "會員", phone: "0912345678", address: "台中市" };

async function memberShop(store: Store, slug: string) {
  const s = await makeShop(store, slug);
  await enableModule(s.ctx, { site: slug, moduleId: "loyalty", config: { maxRedeemPercent: 100 } });
  await enableModule(s.ctx, { site: slug, moduleId: "stored-value", config: {} });
  await enableModule(s.ctx, { site: slug, moduleId: "coupons", config: {} });
  await publishSite(s.ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  const member = (await store.insertMember({ tenant_id: tenant.id, email: contact.email, password_hash: "x", name: contact.name, phone: null }))!;
  return { ...s, tenant, member };
}

/** sandbox PChomePay 付款成功（mock 回查） */
async function sandboxPay(store: Store, tenantId: string, order: { id: string; total: number }, accessKey: string, tenant: Parameters<typeof startPchomepayPayment>[1]["tenant"]) {
  const factory = async () => ({ sandbox: true, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/x" }) } as unknown as PchomepayClient });
  const o = (await store.getOrderById(tenantId, order.id))!;
  const pay = await startPchomepayPayment({ store, baseUrl: "http://t", clientFactory: factory }, { tenant, order: o, accessKey });
  const q: PchomepayQuery = { status: "S", status_code: undefined, amount: o.total, raw: {} };
  return handlePchomepayNotify({ store, baseUrl: "http://t", queryFor: async () => ({ queryPayment: async () => q }) }, { tenantId, rawBody: new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: pay.gatewayOrderNo }) }).toString() });
}

describe("L1：sandbox 付款同交易退回點數、儲值金、優惠券次數", () => {
  it("用了點數＋儲值金＋折扣碼的訂單以 sandbox 付款 → 三者都退回（冪等：之後取消不會多退）", async () => {
    const store = newStore();
    const x = await memberShop(store, "l1-sbx");
    await savePaymentAccount(ctxFor(store), { site: "l1-sbx", appId: "APPIDSBX", secret: "secret-value-123", sandbox: true });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    await adjustPoints(ctxFor(store), { site: "l1-sbx", memberId: x.member.id, amount: 100, reason: "測試", confirm: true });
    await store.creditPost("wallet", { tenantId: x.tenant.id, memberId: x.member.id, kind: "adjust", amount: 200, reason: "測試", mode: "credit" });
    await createCoupon(x.ctx, { site: "l1-sbx", code: "ONCE", kind: "fixed", value: 50, maxUses: 1 });
    const { order, accessKey } = await placeOrder(
      { store, baseUrl: "http://t" },
      { tenant: x.tenant, member: x.member, allowSandbox: true, data: { items: [{ productId: x.mug.id, qty: 2 }], contact, shipping, paymentMethod: "pchomepay", couponCode: "ONCE", pointsToUse: 100, walletToUse: 200 } },
    );
    expect(order).toMatchObject({ points_redeemed: 100, wallet_paid: 200, discount_total: 50 });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(0);
    expect((await store.getCouponByCode(x.tenant.id, "ONCE"))!.used_count).toBe(1);
    const r = await sandboxPay(store, x.tenant.id, order, accessKey, x.tenant);
    expect(r.outcome).toBe("paid");
    expect((await store.getOrderById(x.tenant.id, order.id))!).toMatchObject({ status: "paid", payment_sandbox: true });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(100);
    expect((await store.creditState("wallet", x.tenant.id, x.member.id)).available).toBe(200);
    expect((await store.getCouponByCode(x.tenant.id, "ONCE"))!.used_count).toBe(0);
    // 之後店主取消這張測試訂單：不會再多退
    await cancelOrder(ctxFor(store), { site: "l1-sbx", orderNo: order.order_no, confirm: true });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(100);
    expect((await store.creditState("wallet", x.tenant.id, x.member.id)).balance).toBe(200);
    expect((await store.getCouponByCode(x.tenant.id, "ONCE"))!.used_count).toBe(0);
  });
});

describe("L2／L3：hook 補做", () => {
  it("L2：sandbox 付款後的取消側 hook 失敗 → 補做仍適用（不標 obsolete），成功後 resolved", async () => {
    const store = newStore();
    const x = await memberShop(store, "l2-sbx");
    await savePaymentAccount(ctxFor(store), { site: "l2-sbx", appId: "APPIDSBX", secret: "secret-value-123", sandbox: true });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    let fail = true;
    let runs = 0;
    registerOrderHooks({ name: "zz-l2", cancelled: async () => { runs++; if (fail) throw new Error("boom"); } });
    try {
      const { order, accessKey } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: null, allowSandbox: true, data: { items: [{ productId: x.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay" } });
      await sandboxPay(store, x.tenant.id, order, accessKey, x.tenant);
      expect(await store.listOpenHookFailures({ orderId: order.id, limit: 10, maxAttempts: 20 })).toMatchObject([{ hook: "zz-l2", event: "cancelled" }]);
      fail = false;
      expect(await retryOrderHooks({ store, baseUrl: "http://t" }, { orderId: order.id })).toMatchObject({ resolved: 1 });
      expect(runs).toBe(2);
      expect(await store.listOpenHookFailures({ orderId: order.id, limit: 10, maxAttempts: 20 })).toHaveLength(0);
    } finally {
      registerOrderHooks({ name: "zz-l2" });
    }
  });

  it("L3：公開頁的補做（countAttempts:false）失敗不累加次數、不寄警示；cron 補做才計次", async () => {
    const store = newStore();
    const x = await memberShop(store, "l3-page");
    registerOrderHooks({ name: "zz-l3", paid: async () => { throw new Error("boom"); } });
    const sent: string[] = [];
    try {
      const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: null, data: { items: [{ productId: x.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
      await markOrderPaid(ctxFor(store), { site: "l3-page", orderNo: order.order_no, confirm: true });
      const deps = { store, baseUrl: "http://t", sendMail: async (_to: string, subject: string) => void sent.push(subject) };
      for (let i = 0; i < 6; i++) await retryOrderHooks(deps, { orderId: order.id, countAttempts: false });
      expect((await store.listOpenHookFailures({ orderId: order.id, limit: 10, maxAttempts: 20 }))[0]!.attempts).toBe(1);
      expect(sent.filter((s) => s.includes("處理失敗"))).toHaveLength(0);
      await retryOrderHooks(deps, { orderId: order.id });
      expect((await store.listOpenHookFailures({ orderId: order.id, limit: 10, maxAttempts: 20 }))[0]!.attempts).toBe(2);
    } finally {
      registerOrderHooks({ name: "zz-l3" });
    }
  });
});

describe("M1／M2：儲值", () => {
  it("M1：入帳讀下單時的方案快照（店主事後改贈送額度不影響已下的單）", async () => {
    const store = newStore();
    const x = await memberShop(store, "m1-snap");
    const plan = await createTopupPlan(x.ctx, { site: "m1-snap", name: "儲 1000 送 100", payAmount: 1000, bonusAmount: 100, bonusExpireDays: 30, status: "published", confirm: true });
    const r = await buyTopup({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: x.member, data: { planId: plan.id, contact: { name: contact.name, phone: contact.phone }, paymentMethod: "offline" } });
    // 付款前店主把贈送改成 900（或下架）
    await updateTopupPlan(x.ctx, { site: "m1-snap", planId: plan.id, patch: { bonusAmount: 900, status: "draft" }, confirm: true });
    await markOrderPaid(ctxFor(store), { site: "m1-snap", orderNo: r.order.order_no, confirm: true });
    const paid = (await store.getOrderById(x.tenant.id, r.order.id))!;
    await onWalletOrderPaid({ store, baseUrl: "http://t" }, x.tenant, paid); // 冪等
    expect((await store.creditState("wallet", x.tenant.id, x.member.id)).balance).toBe(1100);
    expect((await store.listAudit(x.tenant.id, 50)).some((a) => a.action === "wallet.topup_no_snapshot")).toBe(false);
  });

  it("M2：取消已入帳的儲值訂單 → 確認前顯示已用／可收回／不足，結果含 shortfall", async () => {
    const store = newStore();
    const x = await memberShop(store, "m2-topup");
    const plan = await createTopupPlan(x.ctx, { site: "m2-topup", name: "儲 1000", payAmount: 1000, status: "published", confirm: true });
    const r = await buyTopup({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: x.member, data: { planId: plan.id, contact: { name: contact.name, phone: contact.phone }, paymentMethod: "offline" } });
    await markOrderPaid(ctxFor(store), { site: "m2-topup", orderNo: r.order.order_no, confirm: true });
    // 客人用掉 700
    await placeOrder({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: x.member, data: { items: [{ productId: x.mug.id, qty: 2 }], contact, shipping, paymentMethod: "offline", walletToUse: 700 } });
    const detail = await getOrder(ctxFor(store), { site: "m2-topup", orderNo: r.order.order_no });
    expect(detail.topupReversal).toMatchObject({ credited: 1000, used: 700, reclaimable: 300, shortfall: 700 });
    await expect(cancelOrder(ctxFor(store), { site: "m2-topup", orderNo: r.order.order_no })).rejects.toThrow(/已用掉.*NT\$700.*只能收回 NT\$300.*不足 NT\$700/);
    const c = await cancelOrder(ctxFor(store), { site: "m2-topup", orderNo: r.order.order_no, confirm: true });
    expect(c.topupReversal).toMatchObject({ credited: 1000, reclaimable: 300, shortfall: 700 });
    expect(c.note).toContain("不足 NT$700");
  });
});
