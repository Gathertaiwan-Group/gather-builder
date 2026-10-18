/**
 * referral 模組：首次付款回饋只觸發一次、不能自己推薦自己、KOL 分潤帳只增不改（取消沖回且冪等）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import { registerMember } from "@/lib/services/members";
import { getOrCreateReferralCode, listReferrals, setReferralKol } from "@/lib/services/referral";
import { checkCoupon } from "@/lib/services/coupons";
import type { MemberRow, Store, TenantRow } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 8).toString("base64");
});

const shipping = { name: "客人", phone: "0912345678", address: "台中市" };

async function refShop(store: Store, slug: string) {
  const shop = await makeShop(store, slug);
  const ctx = ctxFor(store);
  await enableModule(ctx, { site: slug, moduleId: "referral", config: { rewardCoupon: { kind: "fixed", value: 100, validDays: 30 } } });
  await publishSite(ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  const deps = { store, ipSecret: "x-secret-xxxxx", baseUrl: "http://t" };
  await registerMember(deps, { tenant, ip: "1.1.1.1", data: { email: "kol@example.com", password: "password-123", name: "KOL" } });
  const kol = (await store.getMemberByEmail(tenant.id, "kol@example.com"))!;
  const code = await getOrCreateReferralCode(store, tenant, kol);
  return { ...shop, ctx, tenant, kol, code: code.code };
}

async function buy(store: Store, tenant: TenantRow, productId: string, email: string, referralCode: string | undefined, member: MemberRow | null = null) {
  return placeOrder({ store, baseUrl: "http://t" }, { tenant, member, data: { items: [{ productId, qty: 1 }], contact: { name: "朋友", email, phone: "0912000000" }, shipping, paymentMethod: "offline", referralCode } });
}

describe("推薦回饋", () => {
  it("被推薦人首次付款 → 推薦人拿到一張限本人回饋券；同一人第二筆不再觸發", async () => {
    const store = newStore();
    const s = await refShop(store, "ref-once");
    expect(await getOrCreateReferralCode(store, s.tenant, s.kol)).toMatchObject({ code: s.code }); // 同一會員固定一組
    const o1 = await buy(store, s.tenant, s.mug.id, "friend@example.com", s.code);
    expect(o1.order.referral_code).toBe(s.code);
    await markOrderPaid(s.ctx, { site: "ref-once", orderNo: o1.order.order_no, confirm: true });
    let coupons = (await store.listCoupons(s.tenant.id, { limit: 10, offset: 0 })).rows.filter((c) => c.source === "referral");
    expect(coupons).toHaveLength(1);
    expect(coupons[0]).toMatchObject({ assigned_member_id: s.kol.id, value: 100, max_uses: 1 });
    // 回饋券只限推薦人本人
    expect((await checkCoupon(store, s.tenant, { code: coupons[0]!.code, subtotal: 500, member: null, email: "other@example.com" })).ok).toBe(false);
    expect((await checkCoupon(store, s.tenant, { code: coupons[0]!.code, subtotal: 500, member: s.kol, email: s.kol.email })).ok).toBe(true);

    const o2 = await buy(store, s.tenant, s.mug.id, "friend@example.com", s.code);
    await markOrderPaid(s.ctx, { site: "ref-once", orderNo: o2.order.order_no, confirm: true });
    coupons = (await store.listCoupons(s.tenant.id, { limit: 10, offset: 0 })).rows.filter((c) => c.source === "referral");
    expect(coupons).toHaveLength(1);
    // 另一位朋友 → 再一張
    const o3 = await buy(store, s.tenant, s.mug.id, "friend2@example.com", s.code);
    await markOrderPaid(s.ctx, { site: "ref-once", orderNo: o3.order.order_no, confirm: true });
    expect((await store.listCoupons(s.tenant.id, { limit: 10, offset: 0 })).rows.filter((c) => c.source === "referral")).toHaveLength(2);
    expect((await listReferrals(s.ctx, { site: "ref-once" })).totalReferrals).toBe(2);
  });

  it("不能自己推薦自己（會員本人或同 email），推薦碼不存在也忽略", async () => {
    const store = newStore();
    const s = await refShop(store, "ref-self");
    const own = await buy(store, s.tenant, s.mug.id, "kol@example.com", s.code);
    expect(own.order.referral_code).toBeNull();
    const asMember = await buy(store, s.tenant, s.mug.id, "kol-alt@example.com", s.code, s.kol);
    expect(asMember.order.referral_code).toBeNull();
    const fake = await buy(store, s.tenant, s.mug.id, "x@example.com", "NOTEXIST");
    expect(fake.order.referral_code).toBeNull();
    // 就算訂單被寫上自己的推薦碼，付款 hook 也會略過
    await store.setOrderFields(s.tenant.id, own.order.id, {});
    await markOrderPaid(s.ctx, { site: "ref-self", orderNo: own.order.order_no, confirm: true });
    expect((await store.listCoupons(s.tenant.id, { limit: 10, offset: 0 })).rows.filter((c) => c.source === "referral")).toHaveLength(0);
  });

  it("KOL 分潤：付款記 earn、取消記 reverse（只一次）；報表扣掉沖回", async () => {
    const store = newStore();
    const s = await refShop(store, "ref-kol");
    await setReferralKol(s.ctx, { site: "ref-kol", email: "kol@example.com", ratePercent: 10 });
    await expect(setReferralKol(s.ctx, { site: "ref-kol", email: "kol@example.com", ratePercent: 80 })).rejects.toMatchObject({ code: "invalid" });
    const o = await buy(store, s.tenant, s.mug.id, "fan@example.com", s.code);
    await markOrderPaid(s.ctx, { site: "ref-kol", orderNo: o.order.order_no, confirm: true });
    let led = await store.listLedger(s.tenant.id, { limit: 10 });
    expect(led).toEqual([expect.objectContaining({ kind: "earn", amount: 35, order_id: o.order.id })]); // 350 × 10%
    await cancelOrder(s.ctx, { site: "ref-kol", orderNo: o.order.order_no, confirm: true });
    // 重複觸發取消 hook（例如重送）也只會有一筆 reverse
    const { onReferralOrderCancelled } = await import("@/lib/services/referral");
    await onReferralOrderCancelled(store, s.tenant, (await store.getOrderById(s.tenant.id, o.order.id))!);
    led = await store.listLedger(s.tenant.id, { limit: 10 });
    expect(led.map((l) => [l.kind, l.amount]).sort()).toEqual([["earn", 35], ["reverse", -35]]);
    const rep = await listReferrals(s.ctx, { site: "ref-kol" });
    expect(rep.referrers.find((r) => r.email === "kol@example.com")).toMatchObject({ earned: 35, reversed: -35, commission: 0, kolRatePercent: 10 });
  });

  it("審查 M4：KOL 分潤基數扣掉優惠券、等級折扣、點數折抵（與賺點一致）", async () => {
    const store = newStore();
    const s = await refShop(store, "ref-net");
    await setReferralKol(s.ctx, { site: "ref-net", email: "kol@example.com", ratePercent: 10 });
    const o = await buy(store, s.tenant, s.mug.id, "fan2@example.com", s.code);
    const { onReferralOrderPaid } = await import("@/lib/services/referral");
    const { merchandiseNet } = await import("@/lib/loyalty/rules");
    // 小計 350、折扣碼 20、等級折扣 30、點數折抵 50 → 淨額 250 → 分潤 25（舊版算 33）
    const paid = { ...(await store.getOrderById(s.tenant.id, o.order.id))!, status: "paid" as const, discount_total: 20, tier_discount: 30, points_discount: 50 };
    expect(merchandiseNet(paid)).toBe(250);
    await onReferralOrderPaid({ store, baseUrl: "http://t" }, s.tenant, paid);
    expect(await store.listLedger(s.tenant.id, { limit: 10 })).toEqual([expect.objectContaining({ kind: "earn", amount: 25 })]);
  });
});
