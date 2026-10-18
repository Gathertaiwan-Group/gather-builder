/**
 * 第三批獨立審查（2026-10-19）修正的回歸測試：H-1、H-2、M-1～M-5、L-2～L-5（L-1 在 tests/integration/modules.test.ts 打真 DB）。
 * 🔴 全部用假寄信／假 fetch，不寄真信、不打綠界正式環境。
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createSite } from "@/lib/services/sites";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import { registerMember } from "@/lib/services/members";
import { getOrCreateReferralCode } from "@/lib/services/referral";
import { checkCoupon, couponUserKey, createCoupon } from "@/lib/services/coupons";
import { applyPromotions } from "@/lib/services/promotions";
import { createBroadcast, sendBroadcast, subscribe, confirmSubscription, type SendWithId } from "@/lib/services/newsletter";
import { createShipment, handleCvsMapCallback, handleLogisticsNotify, saveShippingAccount, startCvsSelection } from "@/lib/services/shipping";
import { ECPAY_STAGE_TEST_MERCHANTS, checkMacValue, createLogisticsOrder, parseQueryResponse, queryLogisticsOrder, verifyCheckMacValue } from "@/lib/shipping/ecpay";
import { sanitizePrices, parseChineseNumber, PRICE_PLACEHOLDER } from "@/lib/services/ai-chat";
import { handleQuote, QUOTE_COUPON_REJECTED } from "@/lib/shop-routes";
import { guardJsonPost } from "@/lib/public-post";
import { normalizeEmail } from "@/lib/email-normalize";
import type { MemberRow, Store, TenantRow } from "@/lib/store/types";
import { POST as aiChatPost } from "@/app/api/s/[site]/ai-chat/route";
import { POST as newsletterPost } from "@/app/api/s/[site]/newsletter/route";
import { POST as confirmPost } from "@/app/s/[site]/api/newsletter/confirm/route";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 9).toString("base64");
});

const shipTo = { name: "王小明", phone: "0912345678", address: "台中市西屯區測試路 1 號" };
const JSON_H = { "content-type": "application/json" };

/* ================================================================== H-1 推薦 */

async function refShop(store: Store, slug: string, settings: Record<string, unknown> = {}) {
  const shop = await makeShop(store, slug);
  const ctx = ctxFor(store);
  await enableModule(ctx, { site: slug, moduleId: "referral", config: { rewardCoupon: { kind: "fixed", value: 100, validDays: 30 }, ...settings } });
  await publishSite(ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  await registerMember({ store, ipSecret: "x-secret-xxxxx", baseUrl: "http://t" }, { tenant, ip: "1.1.1.1", data: { email: "k.o.l+main@gmail.com", password: "password-123", name: "KOL" } });
  const kol = (await store.getMemberByEmail(tenant.id, "k.o.l+main@gmail.com"))!;
  const code = (await getOrCreateReferralCode(store, tenant, kol)).code;
  return { ...shop, ctx, tenant, kol, code };
}
const buy = (store: Store, tenant: TenantRow, productId: string, email: string, referralCode?: string, member: MemberRow | null = null) =>
  placeOrder({ store, baseUrl: "http://t" }, { tenant, member, data: { items: [{ productId, qty: 1 }], contact: { name: "朋友", email, phone: "0912000000" }, shipping: shipTo, paymentMethod: "offline", referralCode } });
const rewardCoupons = async (store: Store, t: TenantRow) => (await store.listCoupons(t.id, { limit: 50, offset: 0 })).rows.filter((c) => c.source === "referral");

describe("H-1 推薦回饋不能被分身 email 刷", () => {
  it("normalizeEmail：小寫、去 +tag、gmail／googlemail 去點", () => {
    expect(normalizeEmail(" K.O.L+abc@GoogleMail.com ")).toBe("kol@gmail.com");
    expect(normalizeEmail("a.b+x@example.com")).toBe("a.b@example.com");
    expect(normalizeEmail("noat")).toBe("noat");
  });

  it("自推：alias email（+tag／gmail 加點）視為本人 → 推薦碼被忽略", async () => {
    const store = newStore();
    const s = await refShop(store, "rv-self");
    for (const e of ["kol@gmail.com", "k.o.l+2@gmail.com", "KOL+zz@googlemail.com"]) {
      expect((await buy(store, s.tenant, s.mug.id, e, s.code)).order.referral_code).toBeNull();
    }
    // 用本人會員帳號下單、聯絡 email 填別的也一樣
    expect((await buy(store, s.tenant, s.mug.id, "someone-else@example.com", s.code, s.kol)).order.referral_code).toBeNull();
  });

  it("同一收件匣的 alias 只觸發一次回饋（被推薦人鍵用正規化 email）", async () => {
    const store = newStore();
    const s = await refShop(store, "rv-alias");
    for (const e of ["friend@gmail.com", "f.r.i.e.n.d@gmail.com", "friend+2@googlemail.com"]) {
      const o = await buy(store, s.tenant, s.mug.id, e, s.code);
      await markOrderPaid(s.ctx, { site: "rv-alias", orderNo: o.order.order_no, confirm: true });
    }
    expect(await rewardCoupons(store, s.tenant)).toHaveLength(1);
  });

  it("每位推薦人每月回饋上限（rewardMonthlyLimit）", async () => {
    const store = newStore();
    const s = await refShop(store, "rv-cap", { rewardMonthlyLimit: 2 });
    for (let i = 0; i < 4; i++) {
      const o = await buy(store, s.tenant, s.mug.id, `p${i}@example.com`, s.code);
      await markOrderPaid(s.ctx, { site: "rv-cap", orderNo: o.order.order_no, confirm: true });
    }
    expect(await rewardCoupons(store, s.tenant)).toHaveLength(2);
    expect((await store.listAudit(s.tenant.id, 200)).filter((a) => a.action === "referral.reward_capped")).toHaveLength(2);
  });

  it("被推薦訂單取消 → 回饋券停用、推薦紀錄撤銷（冪等），撤銷後不佔每月額度", async () => {
    const store = newStore();
    const s = await refShop(store, "rv-cancel", { rewardMonthlyLimit: 1 });
    const o = await buy(store, s.tenant, s.mug.id, "fr@example.com", s.code);
    await markOrderPaid(s.ctx, { site: "rv-cancel", orderNo: o.order.order_no, confirm: true });
    const [c] = await rewardCoupons(store, s.tenant);
    expect(c!.active).toBe(true);
    await cancelOrder(s.ctx, { site: "rv-cancel", orderNo: o.order.order_no, confirm: true });
    expect((await store.getCouponById(s.tenant.id, c!.id))!.active).toBe(false);
    expect((await checkCoupon(store, s.tenant, { code: c!.code, subtotal: 500, member: s.kol, email: s.kol.email })).ok).toBe(false);
    expect(await store.revokeReferralByOrder(s.tenant.id, o.order.id, "again")).toBeNull(); // 冪等
    expect((await store.listAudit(s.tenant.id, 200)).filter((a) => a.action === "referral.revoke")).toHaveLength(1);
    // 撤銷的不算額度：另一位朋友仍可觸發
    const o2 = await buy(store, s.tenant, s.mug.id, "fr2@example.com", s.code);
    await markOrderPaid(s.ctx, { site: "rv-cancel", orderNo: o2.order.order_no, confirm: true });
    expect((await rewardCoupons(store, s.tenant)).filter((x) => x.active)).toHaveLength(1);
  });
});

/* ================================================================== H-2／M-5／L-3 公開端點 */

function mailbox() {
  const sent: { to: string; text: string }[] = [];
  const send: SendWithId = async (to, _s, text) => {
    sent.push({ to, text });
    return { id: `m${sent.length}`, skipped: false };
  };
  return { sent, send };
}
async function nlSite(store: Store, slug: string) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: slug, modules: ["newsletter"] });
  await publishSite(ctx, { site: slug, confirm: true }).catch(() => undefined);
  return { ctx, tenant: (await store.getTenantBySlug(slug))! };
}

describe("H-2／M-5 公開 JSON POST 門檻", () => {
  it("guardJsonPost：跨站 Origin 403、text/plain 與 form 415、同源 JSON 放行", () => {
    const mk = (h: Record<string, string>) => new Request("http://test.local/api/s/x/newsletter", { method: "POST", headers: h, body: "{}" });
    expect(guardJsonPost(mk({ origin: "https://evil.example", ...JSON_H }), 1000)?.status).toBe(403);
    expect(guardJsonPost(mk({ origin: "http://test.local", "content-type": "text/plain" }), 1000)?.status).toBe(415);
    expect(guardJsonPost(mk({ origin: "http://test.local", "content-type": "application/x-www-form-urlencoded" }), 1000)?.status).toBe(415);
    expect(guardJsonPost(mk({ origin: "http://test.local", "content-type": "application/json; charset=utf-8" }), 1000)).toBeNull();
  });

  it("電子報訂閱與 AI 客服端點：text/plain 簡單請求被拒（415）、跨站被拒（403）", async () => {
    const params = Promise.resolve({ site: "whatever" });
    const plain = new Request("http://test.local/api/s/whatever/newsletter", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ email: "victim@example.com" }) });
    expect((await newsletterPost(plain, { params })).status).toBe(415);
    const cross = new Request("http://test.local/api/s/whatever/ai-chat", { method: "POST", headers: { origin: "https://evil.example", ...JSON_H }, body: "{}" });
    expect((await aiChatPost(cross, { params })).status).toBe(403);
    const plainChat = new Request("http://test.local/api/s/whatever/ai-chat", { method: "POST", body: "{}" });
    expect((await aiChatPost(plainChat, { params })).status).toBe(415);
  });

  it("確認信冷卻：同站同信箱 24h 只寄 1 封（含 alias），未確認期間重複訂閱不換 token、舊連結仍有效", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-cool");
    const mb = mailbox();
    const deps = { store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send };
    await subscribe(deps, { slug: "nl-cool", ip: "1.1.1.1", email: "victim@gmail.com" });
    await subscribe(deps, { slug: "nl-cool", ip: "1.1.1.2", email: "victim@gmail.com" });
    await subscribe(deps, { slug: "nl-cool", ip: "1.1.1.3", email: "v.i.c.t.i.m+x@gmail.com" });
    expect(mb.sent.filter((m) => m.to === "victim@gmail.com")).toHaveLength(1);
    const tok = /token=([A-Za-z0-9_-]+)/.exec(mb.sent[0]!.text)![1]!;
    expect((await confirmSubscription(store, s.tenant, tok)).ok).toBe(true);
  });

  it("跨租戶：同一信箱 24h 內最多 3 封確認信（開很多站一起轟炸無效）", async () => {
    const store = newStore();
    const mb = mailbox();
    const deps = { store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send };
    for (let i = 0; i < 5; i++) {
      await nlSite(store, `nl-bomb-${i}`);
      const r = await subscribe(deps, { slug: `nl-bomb-${i}`, ip: `9.9.9.${i}`, email: "target@example.org" });
      expect(r.message).toMatch(/確認連結/); // 回應一律相同
    }
    expect(mb.sent).toHaveLength(3);
  });

  it("L-3：確認頁 GET 不會確認（頁面不呼叫 confirmSubscription）；POST 才生效且一次性", async () => {
    const page = readFileSync("app/s/[site]/newsletter/confirm/page.tsx", "utf8");
    expect(page).not.toMatch(/confirmSubscription/);
    expect(page).toMatch(/method="post"/);
    const store = newStore();
    const s = await nlSite(store, "nl-post");
    const mb = mailbox();
    await subscribe({ store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send }, { slug: "nl-post", ip: "1.1.1.1", email: "p@example.com" });
    const tok = /token=([A-Za-z0-9_-]+)/.exec(mb.sent[0]!.text)![1]!;
    // 直接用 route 會呼叫 getStore()（Supabase）——這裡改測服務層一次性；route 本身另檢查 Origin
    const cross = new Request("http://test.local/s/nl-post/api/newsletter/confirm", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: `token=${tok}` });
    expect((await confirmPost(cross, { params: Promise.resolve({ site: "nl-post" }) })).status).toBe(403);
    expect((await confirmSubscription(store, s.tenant, tok)).ok).toBe(true);
    expect((await confirmSubscription(store, s.tenant, tok)).ok).toBe(false);
  });
});

/* ================================================================== M-1 群發併發 */

describe("M-1 群發併發不重寄", () => {
  async function siteWithSubs(store: Store, slug: string, n: number) {
    const s = await nlSite(store, slug);
    for (let i = 0; i < n; i++) {
      const mb = mailbox();
      await subscribe({ store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send }, { slug, ip: `5.5.${i}.1`, email: `s${i}@example.com` });
      await confirmSubscription(store, s.tenant, /token=([A-Za-z0-9_-]+)/.exec(mb.sent[0]!.text)![1]!);
    }
    return s;
  }

  it("兩個接續的 send_broadcast 同時跑：每位訂閱者只收到一封", async () => {
    const store = newStore();
    const s = await siteWithSubs(store, "nl-race", 30);
    const b = await createBroadcast(s.ctx, { site: "nl-race", subject: "春季", bodyMd: "內容" });
    // 模擬「已開始群發、還有 30 封待寄」的狀態，再讓兩個呼叫同時接續
    await store.updateBroadcast(s.tenant.id, b.id, ["draft"], { status: "sending" });
    await store.queueDeliveries(s.tenant.id, b.id, (sid) => `h-${sid}`);
    const got: string[] = [];
    const slow: SendWithId = async (to) => {
      got.push(to);
      await new Promise((r) => setTimeout(r, 2));
      return { id: "x", skipped: false };
    };
    await Promise.all([sendBroadcast(s.ctx, { site: "nl-race", broadcastId: b.id, confirm: true }, slow), sendBroadcast(s.ctx, { site: "nl-race", broadcastId: b.id, confirm: true }, slow)]);
    expect(got).toHaveLength(30);
    expect(new Set(got).size).toBe(30);
    const st = await store.deliveryStats(s.tenant.id, b.id);
    expect(st).toMatchObject({ queued: 0, sending: 0, sent: 30 });
  });

  it("併發宣告拿到的列不重疊；宣告後中斷的列標 failed、不重寄", async () => {
    const store = newStore();
    const s = await siteWithSubs(store, "nl-claim", 12);
    const b = await createBroadcast(s.ctx, { site: "nl-claim", subject: "夏季", bodyMd: "內容" });
    await store.updateBroadcast(s.tenant.id, b.id, ["draft"], { status: "sending" });
    await store.queueDeliveries(s.tenant.id, b.id, (sid) => `h-${sid}`);
    const [c1, c2] = await Promise.all([store.claimDeliveries(s.tenant.id, b.id, 8), store.claimDeliveries(s.tenant.id, b.id, 8)]);
    const ids = [...c1, ...c2].map((d) => d.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(await store.failStaleDeliveries(s.tenant.id, b.id, new Date(Date.now() + 60_000).toISOString())).toBe(12);
    const got: string[] = [];
    const r = await sendBroadcast(s.ctx, { site: "nl-claim", broadcastId: b.id, confirm: true }, async (to) => {
      got.push(to);
      return { id: "x", skipped: false };
    });
    expect(got).toHaveLength(0);
    expect(r.remaining).toBe(0);
    expect((await store.deliveryStats(s.tenant.id, b.id)).failed).toBe(12);
  });
});

/* ================================================================== M-2／M-3／L-4 計價與折扣 */

describe("M-2 免運門檻用折扣後金額", () => {
  it("固定運費：小計 1050 滿 1000 免運，但折 100 後 950 → 收運費 80（試算與下單一致）", async () => {
    const store = newStore();
    const s = await makeShop(store, "fs-flat");
    await enableModule(s.ctx, { site: "fs-flat", moduleId: "coupons" });
    await createCoupon(s.ctx, { site: "fs-flat", code: "OFF100", kind: "fixed", value: 100 });
    const items = [{ productId: s.mug.id, qty: 3 }];
    const q = await handleQuote(new Request("http://test.local/q", { method: "POST", headers: JSON_H, body: JSON.stringify({ items, couponCode: "OFF100" }) }), "fs-flat", store);
    expect(await q.json()).toMatchObject({ subtotal: 1050, discount: 100, shippingFee: 80, total: 1030 });
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items, contact: { name: "a", email: "a@example.com", phone: "0912000000" }, shipping: shipTo, paymentMethod: "offline", couponCode: "OFF100" } });
    expect(order).toMatchObject({ subtotal: 1050, discount_total: 100, shipping_fee: 80, total: 1030 });
    // 沒折扣 → 免運
    const q2 = await handleQuote(new Request("http://test.local/q", { method: "POST", headers: JSON_H, body: JSON.stringify({ items }) }), "fs-flat", store);
    expect(await q2.json()).toMatchObject({ shippingFee: 0, total: 1050 });
  });

  it("shipping 模組的方式門檻也用折扣後金額", async () => {
    const store = newStore();
    const s = await makeShop(store, "fs-ship");
    await enableModule(s.ctx, { site: "fs-ship", moduleId: "coupons" });
    await enableModule(s.ctx, { site: "fs-ship", moduleId: "shipping", config: { methods: [{ id: "home", type: "manual", provider: "manual", label: "宅配", fee: 100, freeThreshold: 1000 }] } });
    await publishSite(s.ctx, { site: "fs-ship", confirm: true });
    await createCoupon(s.ctx, { site: "fs-ship", code: "OFF100", kind: "fixed", value: 100 });
    const tenant = (await store.getTenantBySlug("fs-ship"))!; // 重新讀（已發布版本變了）
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 3 }], contact: { name: "a", email: "a@example.com", phone: "0912000000" }, shipping: shipTo, paymentMethod: "offline", couponCode: "OFF100", shippingMethodId: "home" } });
    expect(order).toMatchObject({ discount_total: 100, shipping_fee: 100, total: 1050 });
  });
});

describe("M-3 每人次數以正規化 email 為準", () => {
  it("會員與訪客同 email（含 alias）共用每人次數", async () => {
    const store = newStore();
    const s = await makeShop(store, "pu-key");
    await enableModule(s.ctx, { site: "pu-key", moduleId: "coupons" });
    await createCoupon(s.ctx, { site: "pu-key", code: "ONCE", kind: "fixed", value: 50, perUserLimit: 1 });
    await registerMember({ store, ipSecret: "x-secret-xxxxx", baseUrl: "http://t" }, { tenant: s.tenant, ip: "1.1.1.1", data: { email: "amy@gmail.com", password: "password-123", name: "Amy" } });
    const amy = (await store.getMemberByEmail(s.tenant.id, "amy@gmail.com"))!;
    expect(couponUserKey(amy, "whatever@example.com")).toBe(couponUserKey(null, "A.m.y+promo@gmail.com"));
    const data = (email: string) => ({ items: [{ productId: s.mug.id, qty: 1 }], contact: { name: "a", email, phone: "0912000000" }, shipping: shipTo, paymentMethod: "offline", couponCode: "ONCE" });
    await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: amy, data: data("amy@gmail.com") });
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: data("a.my+2@gmail.com") })).rejects.toThrow(/次數上限|無法使用/);
  });
});

describe("L-4 試算端點不當猜碼神諭", () => {
  it("無效、已過期、未達門檻 → 同一句話", async () => {
    const store = newStore();
    const s = await makeShop(store, "q-oracle");
    await enableModule(s.ctx, { site: "q-oracle", moduleId: "coupons" });
    await createCoupon(s.ctx, { site: "q-oracle", code: "BIG", kind: "fixed", value: 50, minSubtotal: 5000 });
    const msgs = new Set<string>();
    for (const code of ["NOPE", "BIG"]) {
      const q = await handleQuote(new Request("http://test.local/q", { method: "POST", headers: JSON_H, body: JSON.stringify({ items: [{ productId: s.mug.id, qty: 1 }], couponCode: code }) }), "q-oracle", store);
      msgs.add(((await q.json()) as { couponMessage: string }).couponMessage);
    }
    expect([...msgs]).toEqual([QUOTE_COUPON_REJECTED]);
    // 不帶 JSON content-type → 415
    expect((await handleQuote(new Request("http://test.local/q", { method: "POST", body: "{}" }), "q-oracle", store)).status).toBe(415);
  });

  it("promotions 本身仍保留細節（下單時才回）", async () => {
    const store = newStore();
    const s = await makeShop(store, "q-detail");
    await enableModule(s.ctx, { site: "q-detail", moduleId: "coupons" });
    await createCoupon(s.ctx, { site: "q-detail", code: "BIG", kind: "fixed", value: 50, minSubtotal: 5000 });
    await expect(applyPromotions(store, s.tenant, { subtotal: 100, couponCode: "BIG", member: null, email: "a@example.com" })).rejects.toThrow(/最低消費/);
  });
});

/* ================================================================== M-4／L-5 綠界 */

const T = ECPAY_STAGE_TEST_MERCHANTS.C2C;
const METHODS = [{ id: "seven", type: "cvs", provider: "ecpay", subType: "UNIMARTC2C", label: "7-11 取貨", fee: 60 }];

async function cvsShop(store: Store, slug: string, stage: boolean) {
  const shop = await makeShop(store, slug);
  const ctx = ctxFor(store);
  await enableModule(ctx, { site: slug, moduleId: "shipping", config: { methods: METHODS, sender: { name: "林店長", cellPhone: "0911222333" } } });
  await saveShippingAccount(ctx, { site: slug, merchantId: T.merchantId, hashKey: T.hashKey, hashIv: T.hashIv, stage, kind: "C2C" });
  await publishSite(ctx, { site: slug, confirm: true });
  return { ...shop, ctx, tenant: (await store.getTenantBySlug(slug))! };
}
async function paidCvs(store: Store, slug: string, opts: { stage?: boolean; preview?: boolean } = {}) {
  const s = await cvsShop(store, slug, !!opts.stage);
  const a = await startCvsSelection(store, s.tenant, { methodId: "seven", baseUrl: "http://t", mobile: false, allowStage: opts.preview });
  const f = a.form.fields;
  const ra = await handleCvsMapCallback(store, s.tenant.id, { MerchantID: f.MerchantID!, MerchantTradeNo: f.MerchantTradeNo!, LogisticsSubType: f.LogisticsSubType!, CVSStoreID: "131386", CVSStoreName: "門市", CVSAddress: "台北市", CVSOutSide: "0" });
  const { order } = await placeOrder(
    { store, baseUrl: "http://t" },
    { tenant: s.tenant, member: null, allowSandbox: opts.preview, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact: { name: "王小明", email: "b@example.com", phone: "0912345678" }, shipping: shipTo, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } },
  );
  await markOrderPaid(s.ctx, { site: slug, orderNo: order.order_no, confirm: true });
  return { ...s, order };
}
const createOk = (logisticsId = "555") => async (_u: string, init: RequestInit) => {
  const sent = Object.fromEntries(new URLSearchParams(String(init.body)));
  const resp: Record<string, string> = { MerchantID: T.merchantId, MerchantTradeNo: sent.MerchantTradeNo!, RtnCode: "300", RtnMsg: "ok", AllPayLogisticsID: logisticsId, CVSPaymentNo: "C1", CVSValidationNo: "7" };
  resp.CheckMacValue = checkMacValue(resp, T.hashKey, T.hashIv);
  return new Response(`1|${new URLSearchParams(resp).toString()}`);
};
const queryFound = (tradeNo: string, logisticsId = "888") => {
  const f: Record<string, string> = { AllPayLogisticsID: logisticsId, CVSPaymentNo: "Q1", CVSValidationNo: "9", LogisticsStatus: "300", MerchantID: T.merchantId, MerchantTradeNo: tradeNo, TradeDate: "2026/10/19 01:04:34", GoodsName: "測試" };
  f.CheckMacValue = checkMacValue(f, T.hashKey, T.hashIv);
  return Object.entries(f).map(([k, v]) => `${k}=${v}`).join("&");
};

describe("M-4 綠界建單逾時不重複寄件", () => {
  it("查詢回應解析＋CheckMacValue（stage 實測回應向量）", () => {
    const t =
      "ActualWeight=null&AllPayLogisticsID=3696983&BookingNote=&CollectionAllocateAmount=0&CollectionAllocateDate=&CollectionAmount=0&CollectionChargeFee=0&CVSPaymentNo=D8845747&CVSValidationNo=4414&GoodsAmount=100&GoodsName=測試&GoodsWeight=null&HandlingCharge=69&LogisticsStatus=300&LogisticsType=CVS_UNIMARTC2C&MerchantID=2000933&MerchantTradeNo=SJp74aGatQPVxstMuuTz&SenderCellPhone=0911222333&SenderName=林店長&SenderPhone=null&ShipChargeDate=&ShipmentNo=D88457474414&TradeDate=2026/10/19 01:04:34&CheckMacValue=9C8595A4E8B5A5AEEB50884E44927ABA";
    expect(verifyCheckMacValue(parseQueryResponse(t), T.hashKey, T.hashIv)).toBe(true);
  });

  it("逾時 → unknown（不是 failed）；查無（0|找不到訂單）→ not_found；其他 → error", async () => {
    const creds = { merchantId: T.merchantId, hashKey: T.hashKey, hashIv: T.hashIv, stage: true };
    const input = { tradeNo: "X1", type: "cvs" as const, subType: "UNIMARTC2C", goodsAmount: 1, goodsName: "g", sender: { name: "林店長", cellPhone: "0911222333" }, receiver: { name: "王小明", cellPhone: "0912345678", email: "a@example.com", storeId: "1" }, serverReplyUrl: "https://x" };
    expect(await createLogisticsOrder(creds, input, async () => Promise.reject(new Error("timeout")))).toMatchObject({ ok: false, unknown: true });
    expect(await createLogisticsOrder(creds, input, async () => new Response("<html>502</html>", { status: 502 }))).toMatchObject({ ok: false, unknown: true });
    expect(await createLogisticsOrder(creds, input, async () => new Response("0|參數錯誤"))).not.toHaveProperty("unknown", true);
    expect(await queryLogisticsOrder(creds, "X1", async () => new Response("0|找不到訂單", { status: 500 }))).toEqual({ kind: "not_found" });
    expect((await queryLogisticsOrder(creds, "X1", async () => new Response("garbage"))).kind).toBe("error");
    expect((await queryLogisticsOrder(creds, "X1", async () => Promise.reject(new Error("down")))).kind).toBe("error");
  });

  it("建單逾時 → 出貨單維持建立中；再建立 → 先反查：查到就認回（不重送 Create）", async () => {
    const store = newStore();
    const s = await paidCvs(store, "m4-adopt");
    await expect(createShipment(s.ctx, { site: "m4-adopt", orderNo: s.order.order_no, confirm: true }, async () => Promise.reject(new Error("timeout")))).rejects.toThrow(/結果不明/);
    const row = (await store.getActiveShipmentByOrder(s.tenant.id, s.order.id))!;
    expect(row).toMatchObject({ status: "created", logistics_id: null });
    let creates = 0;
    const r = await createShipment(s.ctx, { site: "m4-adopt", orderNo: s.order.order_no, confirm: true }, async (url, init) => {
      if (url.includes("/Express/Create")) {
        creates++;
        return createOk()(url, init);
      }
      return new Response(queryFound(row.merchant_trade_no!));
    });
    expect(creates).toBe(0);
    expect(r).toMatchObject({ logisticsId: "888", trackingNo: "Q1" });
    expect((await store.listShipments(s.tenant.id, { orderId: s.order.id, limit: 10, offset: 0 })).total).toBe(1);
  });

  it("反查確定查無 → confirm 後用同一個 MerchantTradeNo 重送；反查失敗 → 不重送", async () => {
    const store = newStore();
    const s = await paidCvs(store, "m4-retry");
    await expect(createShipment(s.ctx, { site: "m4-retry", orderNo: s.order.order_no, confirm: true }, async () => Promise.reject(new Error("timeout")))).rejects.toThrow(/結果不明/);
    const row = (await store.getActiveShipmentByOrder(s.tenant.id, s.order.id))!;
    await expect(createShipment(s.ctx, { site: "m4-retry", orderNo: s.order.order_no, confirm: true }, async () => new Response("garbage"))).rejects.toThrow(/無法確認/);
    const notFound = async (url: string, init: RequestInit) => (url.includes("/Express/Create") ? createOk("999")(url, init) : new Response("0|找不到訂單", { status: 500 }));
    await expect(createShipment(s.ctx, { site: "m4-retry", orderNo: s.order.order_no }, notFound)).rejects.toMatchObject({ code: "confirm_required" });
    const sentTrade: string[] = [];
    const r = await createShipment(s.ctx, { site: "m4-retry", orderNo: s.order.order_no, confirm: true }, async (url, init) => {
      if (url.includes("/Express/Create")) sentTrade.push(new URLSearchParams(String(init.body)).get("MerchantTradeNo")!);
      return notFound(url, init);
    });
    expect(sentTrade).toEqual([row.merchant_trade_no]);
    expect(r).toMatchObject({ logisticsId: "999" });
    expect((await store.listShipments(s.tenant.id, { orderId: s.order.id, limit: 10, offset: 0 })).total).toBe(1);
  });
});

describe("L-5 綠界測試帳號只能處理預覽／測試訂單", () => {
  it("stage 帳號：正式訂單建物流單被拒；預覽結帳的訂單可以", async () => {
    const store = newStore();
    const real = await cvsShop(store, "l5-real", false);
    // 正式帳號下的一般訂單 → 之後平台把帳號換成 stage
    const a = await startCvsSelection(store, real.tenant, { methodId: "seven", baseUrl: "http://t", mobile: false });
    const f = a.form.fields;
    const ra = await handleCvsMapCallback(store, real.tenant.id, { MerchantID: f.MerchantID!, MerchantTradeNo: f.MerchantTradeNo!, LogisticsSubType: f.LogisticsSubType!, CVSStoreID: "131386", CVSStoreName: "門市", CVSAddress: "台北市", CVSOutSide: "0" });
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: real.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: real.mug.id, qty: 1 }], contact: { name: "王小明", email: "b@example.com", phone: "0912345678" }, shipping: shipTo, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } });
    expect(order.shipping_choice?.stage).toBeUndefined();
    await markOrderPaid(real.ctx, { site: "l5-real", orderNo: order.order_no, confirm: true });
    await saveShippingAccount(real.ctx, { site: "l5-real", merchantId: T.merchantId, hashKey: T.hashKey, hashIv: T.hashIv, stage: true, kind: "C2C" });
    await expect(createShipment(real.ctx, { site: "l5-real", orderNo: order.order_no, confirm: true }, createOk())).rejects.toThrow(/測試環境（stage）/);

    const pv = await paidCvs(store, "l5-preview", { stage: true, preview: true });
    expect(pv.order.shipping_choice?.stage).toBe(true);
    await expect(createShipment(pv.ctx, { site: "l5-preview", orderNo: pv.order.order_no, confirm: true }, createOk())).resolves.toMatchObject({ stage: true });
  });

  it("stage 帳號的狀態通知對到正式訂單 → 不套用", async () => {
    const store = newStore();
    const s = await paidCvs(store, "l5-notify");
    await createShipment(s.ctx, { site: "l5-notify", orderNo: s.order.order_no, confirm: true }, createOk("321"));
    const row = (await store.getActiveShipmentByOrder(s.tenant.id, s.order.id))!;
    await saveShippingAccount(s.ctx, { site: "l5-notify", merchantId: T.merchantId, hashKey: T.hashKey, hashIv: T.hashIv, stage: true, kind: "C2C" });
    const n: Record<string, string> = { MerchantID: T.merchantId, MerchantTradeNo: row.merchant_trade_no!, RtnCode: "2030", RtnMsg: "x", AllPayLogisticsID: "321" };
    const r = await handleLogisticsNotify({ store, baseUrl: "http://t" }, { tenantId: s.tenant.id, rawBody: new URLSearchParams({ ...n, CheckMacValue: checkMacValue(n, T.hashKey, T.hashIv) }).toString() });
    expect(r.outcome).toBe("stage_rejected");
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("paid");
  });
});

/* ================================================================== L-2 AI 價格遮罩 */

describe("L-2 AI 價格遮罩擴大比對", () => {
  it("中文數字", () => {
    expect(parseChineseNumber("一千五百")).toBe(1500);
    expect(parseChineseNumber("兩萬三千")).toBe(23000);
    expect(parseChineseNumber("十二")).toBe(12);
    expect(parseChineseNumber("三百")).toBe(300);
  });
  it("NT／NTD／TWD／新台幣／元／塊／中文數字／萬：不在允許清單就遮；在清單內保留", () => {
    const allowed = new Set([1280, 80, 1500]);
    const cases: [string, number][] = [
      ["只要 TWD 999", 1],
      ["NTD 500 就好", 1],
      ["NT 300", 1],
      ["新台幣 2,000 元", 1],
      ["三百元搞定", 1],
      ["兩千塊", 1],
      ["1.2萬元", 1],
      ["一千五百元", 0],
      ["NT$1,280，運費 80 元", 0],
    ];
    for (const [t, n] of cases) expect(sanitizePrices(t, allowed).redacted, t).toBe(n);
    expect(sanitizePrices("三百元", allowed).text).toBe(PRICE_PLACEHOLDER);
  });
  it("折扣語句一律遮（店家折扣不在 AI 知識內）；「折扣碼」字樣不誤遮", () => {
    const allowed = new Set([1280]);
    for (const t of ["現在打8折", "全館85折", "八折優惠", "現折 100", "折抵100元", "滿千減 100 元"]) expect(sanitizePrices(t, allowed).redacted, t).toBeGreaterThan(0);
    expect(sanitizePrices("結帳時可以輸入折扣碼", allowed).redacted).toBe(0);
    expect(sanitizePrices("營業到 9 點，2026 年開幕", allowed).redacted).toBe(0);
  });
});

void configureModule;
