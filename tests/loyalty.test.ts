/**
 * loyalty（會員點數＋等級，記憶體 Store）：FIFO 到期（純函式）、付款成功賺點冪等、取消沖回（不足扣到 0 並記錄）、
 * 結帳折抵（上限比例、可用不足被拒、取消退回冪等）、折抵後線上金額 < 30 的處理、全額折抵、等級升降、MCP confirm／scope。
 * 真 DB 的併發不超用與 update/delete 被拒在 tests/integration/loyalty-wallet.test.ts。🔴 全部假寄信。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule, configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import { adjustPoints, getMemberPoints, listTiers, onLoyaltyOrderPaid, runLoyaltyCron, updateTiers } from "@/lib/services/loyalty";
import { computeLedgerState } from "@/lib/loyalty/ledger";
import { earnPoints, maxRedeemablePoints, tierForSpend } from "@/lib/loyalty/rules";
import type { MemberRow, Store } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 3).toString("base64");
});
afterEach(() => vi.useRealTimers());

const D = 86400_000;
const contact = { name: "會員甲", email: "vip@example.com", phone: "0912345678" };
const shipping = { name: "會員甲", phone: "0912345678", address: "台中市" };

async function loyaltyShop(store: Store, slug: string, settings: Record<string, unknown> = {}, shop: Record<string, unknown> = {}) {
  const s = await makeShop(store, slug, shop);
  await enableModule(s.ctx, { site: slug, moduleId: "loyalty", config: { earnPerAmount: 100, pointValue: 1, maxRedeemPercent: 50, pointsExpireDays: 365, ...settings } });
  await publishSite(s.ctx, { site: slug, confirm: true });
  const m = (await store.insertMember({ tenant_id: s.tenant.id, email: contact.email, password_hash: "x", name: contact.name, phone: null }))!;
  const tenant = (await store.getTenantBySlug(slug))!;
  return { ...s, tenant, member: m };
}
const buy = (store: Store, x: { tenant: Awaited<ReturnType<typeof loyaltyShop>>["tenant"]; mug: { id: string } }, member: MemberRow | null, extra: Record<string, unknown> = {}, qty = 2) =>
  placeOrder({ store, baseUrl: "http://t" }, { tenant: x.tenant, member, data: { items: [{ productId: x.mug.id, qty }], contact, shipping, paymentMethod: "offline", ...extra } });

describe("帳本 FIFO（純函式，與 SQL builder_ledger_state 同規則）", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  it("先到期的批次先被用掉；到期後只剩未到期批次可用；寫入 expire 後 expiredDue 歸零", () => {
    const e = [
      { kind: "earn", amount: 100, expires_at: at(t0 + 10 * D), created_at: at(t0), seq: 1 },
      { kind: "earn", amount: 50, expires_at: at(t0 + 20 * D), created_at: at(t0 + D), seq: 2 },
      { kind: "redeem", amount: -30, expires_at: null, created_at: at(t0 + 2 * D), seq: 3 },
    ];
    expect(computeLedgerState(e, t0 + 3 * D)).toMatchObject({ balance: 120, available: 120, expiredDue: 0, lots: [{ remaining: 70 }, { remaining: 50 }] });
    const after = computeLedgerState(e, t0 + 11 * D);
    expect(after).toMatchObject({ balance: 120, available: 50, expiredDue: 70 });
    const e2 = [...e, { kind: "expire", amount: -70, expires_at: null, created_at: at(t0 + 11 * D), seq: 4 }];
    expect(computeLedgerState(e2, t0 + 11 * D)).toMatchObject({ balance: 50, available: 50, expiredDue: 0 });
    // 退回 30 點（原本從第一批扣的）：回到已到期的第一批 → 再次到期
    const e3 = [...e2, { kind: "reverse", amount: 30, expires_at: null, created_at: at(t0 + 12 * D), seq: 5 }];
    expect(computeLedgerState(e3, t0 + 12 * D)).toMatchObject({ balance: 80, available: 50, expiredDue: 30 });
  });
  it("規則：賺點 floor(淨額/100)×倍率、折抵上限、等級門檻", () => {
    expect(earnPoints(1299, { earnPerAmount: 100 }, 1.5)).toBe(18);
    expect(earnPoints(99, { earnPerAmount: 100 })).toBe(0);
    expect(maxRedeemablePoints(701, { maxRedeemPercent: 50, pointValue: 2 })).toBe(175);
    const tiers = [{ id: "gold", name: "金", minSpend: 5000, multiplier: 2, discountPercent: 10 }, { id: "silver", name: "銀", minSpend: 1000, multiplier: 1.5, discountPercent: 0 }];
    expect(tierForSpend(tiers, 999)).toBeNull();
    expect(tierForSpend(tiers, 1000)?.id).toBe("silver");
    expect(tierForSpend(tiers, 9000)?.id).toBe("gold");
  });
});

describe("賺點與沖回", () => {
  it("付款成功那一次賺點（商品淨額不含運費）；hook 重跑不重複；sandbox 不賺；取消沖回", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-earn");
    const { order } = await buy(store, x, x.member); // 350×2＝700，運費 80
    await markOrderPaid(ctxFor(store), { site: "ly-earn", orderNo: order.order_no, confirm: true });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(7);
    const paid = (await store.getOrderById(x.tenant.id, order.id))!;
    await onLoyaltyOrderPaid({ store, baseUrl: "http://t" }, x.tenant, paid);
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(7);
    await cancelOrder(ctxFor(store), { site: "ly-earn", orderNo: order.order_no, confirm: true });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(0);
    const ledger = await store.listCreditLedger("points", x.tenant.id, x.member.id, 10);
    expect(ledger.map((l) => [l.kind, l.amount])).toEqual([["reverse", -7], ["earn", 7]]);
  });

  it("已賺的點數被用掉後訂單取消：扣到 0 為止、不足記 shortfall（不變負數）", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-short", { maxRedeemPercent: 100 });
    const a = await buy(store, x, x.member, {}, 3); // 1050 → 10 點
    await markOrderPaid(ctxFor(store), { site: "ly-short", orderNo: a.order.order_no, confirm: true });
    const b = await buy(store, x, x.member, { pointsToUse: 8 }, 1); // 用掉 8 點
    expect(b.order.points_redeemed).toBe(8);
    await markOrderPaid(ctxFor(store), { site: "ly-short", orderNo: b.order.order_no, confirm: true });
    // b 賺 floor((350−8)/100)＝3 點 → 餘額 10−8+3＝5
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(5);
    await cancelOrder(ctxFor(store), { site: "ly-short", orderNo: a.order.order_no, confirm: true });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(0);
    const rev = (await store.listCreditLedger("points", x.tenant.id, x.member.id, 10)).find((l) => l.ref === `order:${a.order.id}:earn_reverse`)!;
    expect(rev.amount).toBe(-5);
    expect(rev.meta).toMatchObject({ requested: 10, shortfall: 5 });
    expect((await store.listAudit(x.tenant.id, 50)).some((l) => l.action === "loyalty.reverse_shortfall")).toBe(true);
  });
});

describe("結帳折抵", () => {
  it("點數折抵：超過上限比例自動降到上限；可用不足被拒；取消退回（冪等）", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-redeem", { maxRedeemPercent: 10 });
    await adjustPoints(ctxFor(store), { site: "ly-redeem", memberId: x.member.id, amount: 500, reason: "開幕贈點", confirm: true });
    await expect(buy(store, x, x.member, { pointsToUse: 501 })).rejects.toThrow(/點數不足/);
    const { order } = await buy(store, x, x.member, { pointsToUse: 300 }); // 700 的 10% → 最多 70 點
    expect(order).toMatchObject({ points_redeemed: 70, points_discount: 70, total: 700 + 80 - 70 });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(430);
    await cancelOrder(ctxFor(store), { site: "ly-redeem", orderNo: order.order_no, confirm: true });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(500);
    // 取消已完成；再取消一次（冪等）也不會多退
    await expect(cancelOrder(ctxFor(store), { site: "ly-redeem", orderNo: order.order_no, confirm: true })).rejects.toMatchObject({ code: "conflict" });
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(500);
    // 訪客不能用點數
    await expect(buy(store, x, null, { pointsToUse: 10 })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("併發：可用 300 點，5 張訂單各用 100 點 → 只成立 3 張（記憶體版；真 DB 另測）", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-race", { maxRedeemPercent: 100 }, {});
    await store.updateProduct(x.tenant.id, x.mug.id, { stock: 100 });
    await adjustPoints(ctxFor(store), { site: "ly-race", memberId: x.member.id, amount: 300, reason: "測試", confirm: true });
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => buy(store, x, x.member, { pointsToUse: 100 }, 1)));
    expect(r.filter((v) => v.status === "fulfilled")).toHaveLength(3);
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(0);
  });

  it("折抵後線上付款金額 1–29 元 → 拒絕並說明；全額折抵 → credit 立即付款成功", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-min", { maxRedeemPercent: 100 }, { shippingFee: 0, freeShippingThreshold: undefined });
    await store.upsertPaymentAccount({ tenant_id: x.tenant.id, provider: "pchomepay", sandbox: false, app_id: "APPID1", secret_enc: "x" });
    await store.markPaymentAccount(x.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    await configureModule(x.ctx, { site: "ly-min", moduleId: "shop", config: { pchomepay: true } });
    await publishSite(x.ctx, { site: "ly-min", confirm: true });
    await adjustPoints(ctxFor(store), { site: "ly-min", memberId: x.member.id, amount: 400, reason: "測試", confirm: true });
    // 350 − 330 ＝ 20 元走線上 → 拒絕
    await expect(buy(store, x, x.member, { pointsToUse: 330, paymentMethod: "pchomepay" }, 1)).rejects.toThrow(/低於線上付款最低金額 NT\$30/);
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(400);
    // 改成全額折抵
    const { order } = await buy(store, x, x.member, { pointsToUse: 350, paymentMethod: "pchomepay" }, 1);
    expect(order).toMatchObject({ payment_method: "credit", total: 0, status: "paid", points_redeemed: 350 });
  });
});

describe("等級", () => {
  it("消費達門檻升級（倍率與等級折扣生效）、取消降級；超過期間後 cron 降級", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-tier", { tiers: [{ id: "silver", name: "銀卡", minSpend: 1000, multiplier: 2, discountPercent: 10 }], tierWindowMonths: 12 });
    await store.updateProduct(x.tenant.id, x.mug.id, { stock: 100 });
    const a = await buy(store, x, x.member, {}, 3); // 1050
    await markOrderPaid(ctxFor(store), { site: "ly-tier", orderNo: a.order.order_no, confirm: true });
    expect((await store.getMemberTier(x.tenant.id, x.member.id))?.tier_id).toBe("silver");
    const b = await buy(store, x, x.member, {}, 1); // 350，銀卡 9 折 → 折 35
    expect(b.order.tier_discount).toBe(35);
    await markOrderPaid(ctxFor(store), { site: "ly-tier", orderNo: b.order.order_no, confirm: true });
    // a 賺 10（升級前，倍率 1）、b 賺 floor(315/100)×2 ＝ 6
    expect((await store.creditState("points", x.tenant.id, x.member.id)).balance).toBe(16);
    await cancelOrder(ctxFor(store), { site: "ly-tier", orderNo: a.order.order_no, confirm: true });
    expect((await store.getMemberTier(x.tenant.id, x.member.id))?.tier_id).toBeNull();
    // 再買到銀卡，13 個月後 cron 降級
    const c = await buy(store, x, x.member, {}, 3);
    await markOrderPaid(ctxFor(store), { site: "ly-tier", orderNo: c.order.order_no, confirm: true });
    expect((await store.getMemberTier(x.tenant.id, x.member.id))?.tier_id).toBe("silver");
    vi.useFakeTimers({ now: Date.now() + 400 * D, toFake: ["Date"] });
    const r = await runLoyaltyCron(store);
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect((await store.getMemberTier(x.tenant.id, x.member.id))?.tier_id).toBeNull();
    // 365 天到期：點數也到期了
    expect((await store.creditState("points", x.tenant.id, x.member.id)).available).toBe(0);
  });

  it("update_tiers 進草稿（發布後才生效）、list_tiers 顯示草稿與人數", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-update");
    await updateTiers(x.ctx, { site: "ly-update", tiers: [{ id: "vip", name: "VIP", minSpend: 3000, multiplier: 1.5, discountPercent: 5 }] });
    const t = await listTiers(x.ctx, { site: "ly-update" });
    expect(t.published).toEqual([]);
    expect(t.draft?.[0]?.id).toBe("vip");
    await expect(updateTiers(x.ctx, { site: "ly-update", tiers: [{ id: "a", name: "A", minSpend: 0 }, { id: "a", name: "B", minSpend: 1 }] })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("MCP 權限", () => {
  it("adjust_points 要 confirm、理由、members:write；扣點不能超過可用；get_member_points 要 members:read", async () => {
    const store = newStore();
    const x = await loyaltyShop(store, "ly-perm");
    await expect(adjustPoints(ctxFor(store), { site: "ly-perm", memberId: x.member.id, amount: 10, reason: "測試" })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(adjustPoints(ctxFor(store), { site: "ly-perm", memberId: x.member.id, amount: 10, reason: "", confirm: true })).rejects.toMatchObject({ code: "invalid" });
    await expect(adjustPoints(ctxFor(store), { site: "ly-perm", memberId: x.member.id, amount: -1, reason: "扣點", confirm: true })).rejects.toThrow(/點數不足/);
    const ro: Actor = { kind: "token", tokenId: "t", tenantId: x.tenant.id, scopes: ["site:read"], label: "ro" };
    await expect(getMemberPoints(ctxFor(store, ro), { memberId: x.member.id })).rejects.toMatchObject({ code: "forbidden" });
    await adjustPoints(ctxFor(store), { site: "ly-perm", email: contact.email, amount: 25, reason: "客訴補償", confirm: true });
    const v = await getMemberPoints(ctxFor(store), { site: "ly-perm", memberId: x.member.id });
    expect(v).toMatchObject({ balance: 25, available: 25, ledger: [{ kind: "adjust", amount: 25, reason: "客訴補償" }] });
  });
});
