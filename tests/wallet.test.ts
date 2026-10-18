/**
 * stored-value（儲值金，記憶體 Store）：付款真正成功才入帳（hook 冪等）、sandbox 不入帳、儲值金全額／部分支付、
 * 可用不足被拒、併發不超用、取消退回冪等、儲值訂單取消收回（不足扣到 0 並記 shortfall）、贈送額度先用且會到期、
 * 發票金額含儲值金、MCP confirm。真 DB 併發與 42501 在 tests/integration/loyalty-wallet.test.ts。🔴 假寄信、mock 金流。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/tokens";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule, configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, handlePchomepayNotify, markOrderPaid, savePaymentAccount, startPchomepayPayment } from "@/lib/services/orders";
import { adjustBalance, buyTopup, createTopupPlan, getMemberBalance, onWalletOrderPaid, runWalletCron } from "@/lib/services/wallet";
import { invoiceAmount } from "@/lib/services/invoices";
import type { PchomepayClient } from "@/lib/pay/pchomepay";
import type { MemberRow, Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 4).toString("base64");
});
afterEach(() => vi.useRealTimers());

const D = 86400_000;
const contact = { name: "儲值客", email: "wallet@example.com", phone: "0912345678" };
const shipping = { name: "儲值客", phone: "0912345678", address: "台中市" };

async function walletShop(store: Store, slug: string, opts: { loyalty?: boolean } = {}) {
  const s = await makeShop(store, slug, { shippingFee: 0 });
  await enableModule(s.ctx, { site: slug, moduleId: "stored-value", config: { notice: "儲值金不可兌換現金。" } });
  if (opts.loyalty) await enableModule(s.ctx, { site: slug, moduleId: "loyalty", config: { maxRedeemPercent: 100 } });
  await publishSite(s.ctx, { site: slug, confirm: true });
  await store.updateProduct(s.tenant.id, s.mug.id, { stock: 100 });
  const member = (await store.insertMember({ tenant_id: s.tenant.id, email: contact.email, password_hash: "x", name: contact.name, phone: null }))!;
  const plan = await createTopupPlan(s.ctx, { site: slug, name: "儲 1000 送 100", payAmount: 1000, bonusAmount: 100, bonusExpireDays: 30, status: "published", confirm: true });
  return { ...s, tenant: (await store.getTenantBySlug(slug))!, member, plan };
}
const deps = (store: Store) => ({ store, baseUrl: "http://t" });
const topup = (store: Store, x: Awaited<ReturnType<typeof walletShop>>, member: MemberRow | null = x.member, extra: Record<string, unknown> = {}) =>
  buyTopup(deps(store), { tenant: x.tenant, member, data: { planId: x.plan.id, contact: { name: contact.name, phone: contact.phone }, paymentMethod: "offline", ...extra } });
const buy = (store: Store, x: Awaited<ReturnType<typeof walletShop>>, extra: Record<string, unknown> = {}, qty = 1) =>
  placeOrder(deps(store), { tenant: x.tenant, member: x.member, data: { items: [{ productId: x.mug.id, qty }], contact, shipping, paymentMethod: "offline", ...extra } });
const bal = async (store: Store, x: Awaited<ReturnType<typeof walletShop>>) => store.creditState("wallet", x.tenant.id, x.member.id);

describe("購買儲值", () => {
  it("線下匯款：付款前不入帳；mark_order_paid 那一次入帳本金＋贈送；hook 重跑不重複；訪客不能買", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-buy");
    await expect(topup(store, x, null)).rejects.toMatchObject({ code: "unauthorized" });
    const { order } = await topup(store, x);
    expect(order.total).toBe(1000);
    expect((await bal(store, x)).balance).toBe(0);
    await markOrderPaid(ctxFor(store), { site: "sv-buy", orderNo: order.order_no, confirm: true });
    expect(await bal(store, x)).toMatchObject({ balance: 1100, available: 1100 });
    await onWalletOrderPaid(deps(store), x.tenant, (await store.getOrderById(x.tenant.id, order.id))!);
    expect((await bal(store, x)).balance).toBe(1100);
    // 儲值訂單不開發票、不賺點
    expect(order.items[0]).toMatchObject({ item_kind: "topup" });
  });

  it("沒有預覽簽章不能用 sandbox 金流買儲值（H1）", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-sbx");
    await savePaymentAccount(ctxFor(store), { site: "sv-sbx", appId: "APPIDSBX", secret: "secret-value-123", sandbox: true });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    await expect(topup(store, x, x.member, { paymentMethod: "pchomepay" })).rejects.toThrow(/無法使用線上付款/);
  });

  it("sandbox（帶預覽簽章）付款成功 → 訂單 paid＋sandbox，但儲值金不入帳", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-sbx2");
    await savePaymentAccount(ctxFor(store), { site: "sv-sbx2", appId: "APPIDSBX", secret: "secret-value-123", sandbox: true });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const r = await buyTopup(deps(store), { tenant: x.tenant, member: x.member, allowSandbox: true, data: { planId: x.plan.id, contact: { name: contact.name, phone: contact.phone }, paymentMethod: "pchomepay" } });
    const factory = async () => ({ sandbox: true, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/x" }) } as unknown as PchomepayClient });
    const pay = await startPchomepayPayment({ store, baseUrl: "http://t", clientFactory: factory }, { tenant: x.tenant, order: r.order, accessKey: r.accessKey });
    const out = await handlePchomepayNotify({ store, baseUrl: "http://t", queryFor: async () => ({ queryPayment: async () => ({ status: "S", amount: 1000, raw: {} }) }) }, { tenantId: x.tenant.id, rawBody: new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: pay.gatewayOrderNo }) }).toString() });
    expect(out.outcome).toBe("paid");
    expect((await store.getOrderById(x.tenant.id, r.order.id))!).toMatchObject({ status: "paid", payment_sandbox: true });
    expect((await bal(store, x)).balance).toBe(0);
  });
});

describe("用儲值金付款", () => {
  async function funded(slug: string, opts: { loyalty?: boolean } = {}) {
    const store = newStore();
    const x = await walletShop(store, slug, opts);
    const { order } = await topup(store, x);
    await markOrderPaid(ctxFor(store), { site: slug, orderNo: order.order_no, confirm: true });
    return { store, x };
  }

  it("部分支付：剩下的走線下匯款；全額：credit 立即付款成功；不足被拒；取消退回（冪等）", async () => {
    const { store, x } = await funded("sv-pay");
    const a = await buy(store, x, { walletToUse: 200 }, 1); // 350 − 200 ＝ 150
    expect(a.order).toMatchObject({ wallet_paid: 200, total: 150, payment_method: "offline", status: "pending_payment" });
    expect((await bal(store, x)).available).toBe(900);
    await expect(buy(store, x, { walletToUse: 5000 }, 2)).rejects.toThrow(/餘額不足/);
    await cancelOrder(ctxFor(store), { site: "sv-pay", orderNo: a.order.order_no, confirm: true });
    expect((await bal(store, x)).available).toBe(1100);
  });

  it("可用不足被拒；全額支付 → credit、立即已付款；取消退回且再取消不重複退", async () => {
    const { store, x } = await funded("sv-full");
    await expect(buy(store, x, { walletToUse: 1200 })).rejects.toThrow(/餘額不足/);
    const { order } = await buy(store, x, { walletToUse: 1100 }, 2); // 700：只扣 700
    expect(order).toMatchObject({ wallet_paid: 700, total: 0, payment_method: "credit", status: "paid" });
    expect((await bal(store, x)).available).toBe(400);
    // 贈送 100（會到期）先用掉
    const v = await getMemberBalance(ctxFor(store), { site: "sv-full", memberId: x.member.id });
    expect(v.expiringBonus).toEqual([]);
    const c = await cancelOrder(ctxFor(store), { site: "sv-full", orderNo: order.order_no, confirm: true });
    expect(c.refundRequired).toBe(false);
    expect((await bal(store, x)).available).toBe(1100);
    await expect(cancelOrder(ctxFor(store), { site: "sv-full", orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "conflict" });
    expect((await bal(store, x)).available).toBe(1100);
    // 發票金額＝實付＋儲值金
    expect(invoiceAmount(order)).toBe(700);
  });

  it("併發：可用 1100，5 張訂單各用 350 → 只成立 3 張", async () => {
    const { store, x } = await funded("sv-race");
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => buy(store, x, { walletToUse: 350 }, 1)));
    expect(r.filter((v) => v.status === "fulfilled")).toHaveLength(3);
    expect((await bal(store, x)).available).toBe(50);
  });

  it("點數＋儲值金併用：折抵後剩 1–29 元選線上 → 拒絕；儲值金剛好補足 → credit", async () => {
    const { store, x } = await funded("sv-mix", { loyalty: true });
    await store.upsertPaymentAccount({ tenant_id: x.tenant.id, provider: "pchomepay", sandbox: false, app_id: "APPID1", secret_enc: "x" });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    await configureModule(x.ctx, { site: "sv-mix", moduleId: "shop", config: { pchomepay: true } });
    await publishSite(x.ctx, { site: "sv-mix", confirm: true });
    await expect(buy(store, x, { walletToUse: 330, paymentMethod: "pchomepay" })).rejects.toThrow(/低於線上付款最低金額/);
    expect((await bal(store, x)).available).toBe(1100);
    const { order } = await buy(store, x, { walletToUse: 350, paymentMethod: "pchomepay" });
    expect(order.payment_method).toBe("credit");
    // 儲值金消費一樣賺點（350 → 3 點）
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(3);
  });
});

describe("儲值訂單取消與到期", () => {
  it("儲值後用掉一部分再取消儲值訂單 → 收回到 0 為止、記 shortfall", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-rev");
    const t = await topup(store, x);
    await markOrderPaid(ctxFor(store), { site: "sv-rev", orderNo: t.order.order_no, confirm: true });
    const spent = await buy(store, x, { walletToUse: 350 });
    expect(spent.order.wallet_paid).toBe(350);
    await cancelOrder(ctxFor(store), { site: "sv-rev", orderNo: t.order.order_no, confirm: true });
    expect((await bal(store, x)).balance).toBe(0);
    const rev = (await store.listCreditLedger("wallet", x.tenant.id, x.member.id, 10)).find((l) => l.ref === `order:${t.order.id}:topup_reverse`)!;
    expect(rev).toMatchObject({ amount: -750, meta: { requested: 1100, shortfall: 350 } });
    expect((await store.listAudit(x.tenant.id, 50)).some((a) => a.action === "wallet.reverse_shortfall")).toBe(true);
  });

  it("贈送額度到期（cron）：本金不到期", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-exp");
    const t = await topup(store, x);
    await markOrderPaid(ctxFor(store), { site: "sv-exp", orderNo: t.order.order_no, confirm: true });
    vi.useFakeTimers({ now: Date.now() + 31 * D, toFake: ["Date"] });
    expect(await bal(store, x)).toMatchObject({ balance: 1100, available: 1000, expiredDue: 100 });
    expect(await runWalletCron(store)).toMatchObject({ expired: 100 });
    expect(await bal(store, x)).toMatchObject({ balance: 1000, available: 1000, expiredDue: 0 });
  });
});

describe("MCP", () => {
  it("adjust_balance 要 confirm＋理由；扣款不能超過可用；方案上架要 confirm", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-mcp");
    await expect(adjustBalance(ctxFor(store), { site: "sv-mcp", memberId: x.member.id, amount: 100, reason: "補償" })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(adjustBalance(ctxFor(store), { site: "sv-mcp", memberId: x.member.id, amount: -1, reason: "扣回", confirm: true })).rejects.toThrow(/餘額不足/);
    await adjustBalance(ctxFor(store), { site: "sv-mcp", email: contact.email, amount: 100, reason: "補償", confirm: true });
    expect((await bal(store, x)).balance).toBe(100);
    await expect(createTopupPlan(x.ctx, { site: "sv-mcp", name: "x", payAmount: 500, status: "published" })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(createTopupPlan(x.ctx, { site: "sv-mcp", name: "x", payAmount: 10 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("審查 M3：adjust_balance 需要 wallet:adjust（members:write 不夠）；單次 NT$3,000、每日 NT$10,000 上限；被拒寫稽核", async () => {
    const store = newStore();
    const x = await walletShop(store, "sv-m3");
    const mw: Actor = { kind: "token", tokenId: "t", tenantId: x.tenant.id, scopes: ["members:read", "members:write"], label: "mw" };
    await expect(adjustBalance(ctxFor(store, mw), { memberId: x.member.id, amount: 10, reason: "補償", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    const wa: Actor = { ...mw, scopes: ["wallet:adjust"], label: "wa" };
    await expect(adjustBalance(ctxFor(store, wa), { memberId: x.member.id, amount: 3001, reason: "太多", confirm: true })).rejects.toThrow(/單次調整上限 NT\$3,000/);
    for (let i = 0; i < 3; i++) await adjustBalance(ctxFor(store, wa), { memberId: x.member.id, amount: 3000, reason: "補償", confirm: true });
    await expect(adjustBalance(ctxFor(store, wa), { memberId: x.member.id, amount: 1001, reason: "補償", confirm: true })).rejects.toThrow(/每日上限 NT\$10,000/);
    expect((await store.listAudit(x.tenant.id, 50)).filter((a) => a.action === "wallet.adjust_rejected")).toHaveLength(2);
  });
});
