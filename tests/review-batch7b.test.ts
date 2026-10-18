/**
 * 第七批獨立審查（第二輪）修正：H1 短網址與長度上限、H4 儲值訂單退款、M1 已出貨退款撤回副作用、M2 LINE Pay 訂單非待付款先回查、
 * L1 failed 付款回查無法辨識要求重送、L2 卡住的退款可標記／cron 轉不明、L4 手動調整上限原子＋只能由平台後台調高。
 * 記憶體 Store＋假的 fetch。🔴 不打任何真實 API、不輸入卡號、不發起真實退款。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { fulfillOrder, handleLinepayConfirm, handleProviderNotify, providerUrls, refundOrder, resolveRefund, saveProviderAccount, startOnlinePayment, sweepStaleRefunds, confirmLinepayPayment, cancelOrder, type PayDeps } from "@/lib/services/orders";
import { createLinepayProvider } from "@/lib/pay/linepay";
import { payToken } from "@/lib/pay/notify-token";
import { CALLBACK_URL_LIMITS, SHORT_CODE_RE, genShortCode, shortPayUrls } from "@/lib/pay/urls";
import { PROVIDER_IDS, type FetchLike, type PaymentProvider, type ProviderId } from "@/lib/pay/types";
import { handleShortLinepayConfirm, handleShortReturn } from "@/lib/pay-short-routes";
import { decryptSecret } from "@/lib/secretbox";
import { adjustBalance, buyTopup, createTopupPlan } from "@/lib/services/wallet";
import { adjustPoints } from "@/lib/services/loyalty";
import { setAdjustLimits } from "@/lib/services/adjust-limits";
import { configureModule } from "@/lib/services/modules";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "https://test.example";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 9).toString("base64");
});

const contact = { name: "客人", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "客人", phone: "0912345678", address: "台中市" };
const json = (o: unknown) => new Response(typeof o === "string" ? o : JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const TID = "2026101958491409700";
const HOST64 = `https://${"a".repeat(53)}.example.tw`; // 64 字網域（正式網域可能最長的估算）

function fakeLinepay() {
  const st = { checkCode: "0000", confirms: [] as number[], refunds: [] as number[], refundCode: "0000", paidAmount: 0 };
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname === "/v3/payments/request") {
      st.paidAmount = body.amount;
      return json(`{"returnCode":"0000","returnMessage":"OK","info":{"transactionId":${TID},"paymentUrl":{"web":"https://sandbox-web-pay.line.me/web/payment/wait?x=1","app":"line://pay/x"}}}`);
    }
    if (u.pathname === `/v3/payments/${TID}/confirm`) {
      st.confirms.push(body.amount);
      st.checkCode = "0123";
      return json(`{"returnCode":"0000","info":{"orderId":"x","transactionId":${TID},"payInfo":[{"method":"BALANCE","amount":${body.amount}}]}}`);
    }
    if (u.pathname === `/v3/payments/requests/${TID}/check`) return json({ returnCode: st.checkCode, returnMessage: "" });
    if (u.pathname === "/v3/payments") return json(`{"returnCode":"0000","info":[{"transactionId":${TID},"transactionType":"PAYMENT","payInfo":[{"method":"BALANCE","amount":${st.paidAmount}}]}]}`);
    if (u.pathname === `/v3/payments/${TID}/refund`) {
      st.refunds.push(body.refundAmount);
      return json(`{"returnCode":"${st.refundCode}","returnMessage":"","info":{"refundTransactionId":2026101958491409999}}`);
    }
    throw new Error(`unexpected ${url}`);
  };
  return { st, fetch };
}

async function lpShop(store: Store, slug: string, modules: string[] = []) {
  const shop = await makeShop(store, slug);
  for (const m of modules) await enableModule(shop.ctx, { site: slug, moduleId: m, config: {} });
  if (modules.length) await publishSite(shop.ctx, { site: slug, confirm: true }).catch(() => undefined);
  await saveProviderAccount(ctxFor(store), { site: slug, provider: "linepay", appId: "1234567890", secrets: { channelSecret: "a917ab6a2367b536f8e5a6e2977e06f4" }, sandbox: false });
  await store.markPaymentAccount(shop.tenant.id, "linepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  const lp = fakeLinepay();
  const provider = createLinepayProvider({ channelId: "1234567890", channelSecret: "a917ab6a2367b536f8e5a6e2977e06f4", sandbox: false }, lp.fetch);
  const sent: string[] = [];
  const deps: PayDeps = { store, baseUrl: "https://test.example", sendMail: async (_t, subject) => void sent.push(subject), providerFor: async () => provider };
  const member = (await store.insertMember({ tenant_id: shop.tenant.id, email: `m-${slug}@example.com`, password_hash: "x", name: "會員", phone: null }))!;
  const pay = async (order: Awaited<ReturnType<typeof placeOrder>>["order"], accessKey: string) => {
    const p = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => provider }, { tenant: shop.tenant, order, accessKey });
    const payment = (await store.getPaymentByGatewayNo(p.gatewayOrderNo))!;
    await handleLinepayConfirm(deps, { tenantId: shop.tenant.id, paymentId: payment.id, token: payToken("confirm", payment.id), transactionId: TID, orderId: payment.gateway_order_no });
    return payment;
  };
  const order = async (withMember = false) => {
    const { order, accessKey } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: shop.tenant, member: withMember ? member : null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "linepay" } });
    return { order, accessKey };
  };
  return { ...shop, lp, provider, deps, sent, member, pay, order };
}

describe("H1：金流 callback 短網址與長度上限", () => {
  it("每一家：64 字網域的短網址都在該家上限內；舊版藍新網址確實超過 200（審查發現的問題）", () => {
    for (const p of PROVIDER_IDS) {
      const u = shortPayUrls(HOST64, genShortCode(), p);
      for (const v of Object.values(u)) expect(v.length, `${p} ${v}`).toBeLessThanOrEqual(CALLBACK_URL_LIMITS[p]);
    }
    const old = providerUrls(HOST64, { id: "11111111-2222-3333-4444-555555555555", slug: "a".repeat(40) } as never, { id: "11111111-2222-3333-4444-555555555555", gateway_order_no: "GB1234567890ABCDEFGH", provider: "newebpay" }, "ABCDEFGH-20261019-0001", "x".repeat(32));
    expect(old.returnUrl.length).toBeGreaterThan(200);
  });

  it("短碼：18 字英數、1000 個不重複", () => {
    const set = new Set(Array.from({ length: 1000 }, () => genShortCode()));
    expect(set.size).toBe(1000);
    for (const c of set) expect(c).toMatch(SHORT_CODE_RE);
  });

  it("建單：每一家送給金流的網址都是短網址且 ≤ 上限；網域太長直接拒絕、不建付款紀錄", async () => {
    const store = newStore();
    const shop = await makeShop(store, "h1-len");
    const { order, accessKey } = await placeOrder({ store, baseUrl: HOST64 }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    for (const p of PROVIDER_IDS.filter((x) => x !== "pchomepay")) {
      let seen: Record<string, string> = {};
      const fake = { id: p, sandbox: false, verifyCredentials: async () => ({ ok: true as const }), createPayment: async (i: { returnUrl: string; notifyUrl: string; cancelUrl?: string }) => ((seen = { returnUrl: i.returnUrl, notifyUrl: i.notifyUrl, cancelUrl: i.cancelUrl ?? "" }), { kind: "redirect" as const, url: "https://pay.example/x" }), queryPayment: async () => null } as unknown as PaymentProvider;
      await startOnlinePayment({ store, baseUrl: HOST64, providerFactory: async () => fake }, { tenant: shop.tenant, order: { ...order, payment_method: p as ProviderId }, accessKey });
      for (const v of Object.values(seen)) {
        expect(v.length, `${p} ${v}`).toBeLessThanOrEqual(CALLBACK_URL_LIMITS[p as ProviderId]);
        expect(v).toMatch(/\/p\/[ncr]\/[A-Za-z0-9]{18}$/);
      }
    }
    const before = (await store.listPaymentsForOrder(shop.tenant.id, order.id)).length;
    const fake = { id: "newebpay", sandbox: false, createPayment: async () => ({ kind: "redirect" as const, url: "https://x" }) } as unknown as PaymentProvider;
    await expect(startOnlinePayment({ store, baseUrl: `https://${"z".repeat(190)}.tw`, providerFactory: async () => fake }, { tenant: shop.tenant, order: { ...order, payment_method: "newebpay" }, accessKey })).rejects.toThrow(/超過上限 200/);
    expect((await store.listPaymentsForOrder(shop.tenant.id, order.id)).length).toBe(before);
  });

  it("短網址路由：導回 303 到訂單頁（帶存取金鑰，金鑰在 DB 加密）；LINE Pay confirm 經短網址完成；不存在的碼 404", async () => {
    const store = newStore();
    const s = await lpShop(store, "h1-route");
    const { order, accessKey } = await s.order();
    const p = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => s.provider }, { tenant: s.tenant, order, accessKey });
    const payment = (await store.getPaymentByGatewayNo(p.gatewayOrderNo))!;
    expect(payment.short_code).toMatch(SHORT_CODE_RE);
    expect(payment.return_key_enc).not.toContain(accessKey);
    expect(decryptSecret(payment.return_key_enc!, s.tenant.id)).toBe(accessKey);
    const ret = await handleShortReturn(new Request(`https://test.example/p/r/${payment.short_code}`, { method: "POST" }), payment.short_code!, store);
    expect(ret.status).toBe(303);
    expect(ret.headers.get("location")).toBe(`https://test.example/s/h1-route/orders/${encodeURIComponent(order.order_no)}?k=${encodeURIComponent(accessKey)}`);
    const conf = await handleShortLinepayConfirm(new Request(`https://test.example/p/c/${payment.short_code}?transactionId=${TID}&orderId=${payment.gateway_order_no}`), payment.short_code!, store, { providerFor: async () => s.provider });
    expect(conf.status).toBe(303);
    expect(s.lp.st.confirms).toEqual([order.total]);
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("paid");
    // 竄改 transactionId → 400、不 confirm
    expect((await handleShortLinepayConfirm(new Request(`https://test.example/p/c/${payment.short_code}?transactionId=2026101958491409701&orderId=${payment.gateway_order_no}`), payment.short_code!, store, { providerFor: async () => s.provider })).status).toBe(400);
    expect((await handleShortReturn(new Request("https://test.example/p/r/x"), "AAAAAAAAAAAAAAAAAA", store)).status).toBe(404);
    expect((await handleShortReturn(new Request("https://test.example/p/r/x"), "../etc", store)).status).toBe(404);
  });
});

describe("H4：儲值訂單退款", () => {
  async function topupShop(store: Store, slug: string) {
    const s = await lpShop(store, slug, ["stored-value"]);
    const plan = await createTopupPlan(s.ctx, { site: slug, name: "儲 1000 送 100", payAmount: 1000, bonusAmount: 100, status: "published", confirm: true });
    const buy = async () => {
      const r = await buyTopup({ store, baseUrl: "https://test.example" }, { tenant: s.tenant, member: s.member, data: { planId: plan.id, contact: { name: "會員", phone: "0912000111" }, paymentMethod: "linepay" } });
      await s.pay(r.order, r.accessKey);
      return (await store.getOrderById(s.tenant.id, r.order.id))!;
    };
    return { ...s, plan, buy };
  }

  it("客人已用掉一部分 → 拒絕自動退款（訊息含已用／可收回），不呼叫 provider、不取消訂單", async () => {
    const store = newStore();
    const s = await topupShop(store, "h4-used");
    const o = await s.buy();
    expect(o.status).toBe("paid");
    await adjustBalance(ctxFor(store), { site: "h4-used", memberId: s.member.id, amount: -200, reason: "模擬已使用", confirm: true });
    await expect(refundOrder(ctxFor(store), { site: "h4-used", orderNo: o.order_no, confirm: true }, async () => s.provider)).rejects.toThrow(/已用掉.*可收回.*人工退款/s);
    expect(s.lp.st.refunds).toHaveLength(0);
    expect((await store.getOrderById(s.tenant.id, o.id))!.status).toBe("paid");
  });

  it("沒用過 → 確認訊息含儲值金試算；先收回儲值金（取消訂單）再退款；餘額歸零、只退一次", async () => {
    const store = newStore();
    const s = await topupShop(store, "h4-ok");
    const o = await s.buy();
    expect((await store.creditState("wallet", s.tenant.id, s.member.id)).available).toBe(1100);
    await expect(refundOrder(ctxFor(store), { site: "h4-ok", orderNo: o.order_no }, async () => s.provider)).rejects.toThrow(/儲值金.*先收回儲值金再退款/s);
    const r = await refundOrder(ctxFor(store), { site: "h4-ok", orderNo: o.order_no, confirm: true }, async () => s.provider);
    expect(r).toMatchObject({ refunded: true, amount: 1000, orderCancelled: true });
    expect(s.lp.st.refunds).toEqual([1000]);
    expect((await store.creditState("wallet", s.tenant.id, s.member.id)).available).toBe(0);
    expect((await store.listPaymentsForOrder(s.tenant.id, o.id))[0]!.status).toBe("refunded");
  });
});

describe("M1：已出貨訂單退款撤回副作用", () => {
  it("已出貨 → 退款後 refunded_at、付款 refunded、沖回賺的點數；不回補庫存；訂單維持已出貨", async () => {
    const store = newStore();
    const s = await lpShop(store, "m1-ful", ["loyalty"]);
    const { order, accessKey } = await s.order(true);
    await s.pay(order, accessKey);
    expect((await store.creditState("points", s.tenant.id, s.member.id)).balance).toBeGreaterThan(0);
    await fulfillOrder(ctxFor(store), { site: "m1-ful", orderNo: order.order_no, confirm: true });
    const stockBefore = (await store.getProductById(s.tenant.id, s.mug.id))!.stock;
    await expect(refundOrder(ctxFor(store), { site: "m1-ful", orderNo: order.order_no }, async () => s.provider)).rejects.toThrow(/不回補庫存.*沖回/s);
    const r = await refundOrder(ctxFor(store), { site: "m1-ful", orderNo: order.order_no, confirm: true }, async () => s.provider);
    expect(r).toMatchObject({ refunded: true, refundedAfterFulfil: true, orderCancelled: false });
    const after = (await store.getOrderById(s.tenant.id, order.id))!;
    expect(after.status).toBe("fulfilled");
    expect(after.refunded_at).toBeTruthy();
    expect((await store.listPaymentsForOrder(s.tenant.id, order.id))[0]!.status).toBe("refunded");
    expect((await store.creditState("points", s.tenant.id, s.member.id)).balance).toBe(0);
    expect((await store.getProductById(s.tenant.id, s.mug.id))!.stock).toBe(stockBefore);
    // 冪等：再標記一次不會再跑
    expect(await store.markOrderRefunded(s.tenant.id, order.id)).toBeNull();
  });
});

describe("M2／L1：回查優先", () => {
  it("M2：訂單已取消後 LINE Pay 其實已請款（0123）→ paid_after_cancel＋警示，不是直接標 failed", async () => {
    const store = newStore();
    const s = await lpShop(store, "m2-lp");
    const { order, accessKey } = await s.order();
    const p = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => s.provider }, { tenant: s.tenant, order, accessKey });
    const payment = (await store.getPaymentByGatewayNo(p.gatewayOrderNo))!;
    await cancelOrder(ctxFor(store), { site: "m2-lp", orderNo: order.order_no, confirm: true });
    s.lp.st.checkCode = "0123";
    expect(await confirmLinepayPayment(s.deps, s.tenant, payment, order)).toBe("failed");
    expect((await store.listPaymentsForOrder(s.tenant.id, order.id))[0]!.status).toBe("paid_after_cancel");
    expect(s.sent.some((m) => m.includes("已取消的訂單收到付款"))).toBe(true);
    expect(s.lp.st.confirms).toHaveLength(0);
  });

  it("L1：之前失敗的付款，回查無法辨識 → 要求重送（不回 ok）", async () => {
    const store = newStore();
    const shop = await makeShop(store, "l1-unk");
    await saveProviderAccount(ctxFor(store), { site: "l1-unk", provider: "newebpay", appId: "MS12345678", secrets: { hashKey: "a".repeat(32), hashIv: "b".repeat(16) }, sandbox: false });
    const { order } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    const payment = await store.insertPayment({ tenant_id: shop.tenant.id, order_id: order.id, provider: "newebpay", gateway_order_no: "GBL1UNKNOWN000000001", amount: order.total, sandbox: false });
    await store.updatePayment(shop.tenant.id, payment.id, { status: "failed" });
    const fake = { id: "newebpay", sandbox: false, verifyCallback: () => ({ ok: true, gatewayOrderNo: payment.gateway_order_no }), queryPayment: async () => ({ state: "unknown", amount: null, statusText: "TradeStatus=6", raw: {} }) } as unknown as PaymentProvider;
    const r = await handleProviderNotify({ store, baseUrl: "https://test.example", providerFor: async () => fake }, { provider: "newebpay", tenantId: shop.tenant.id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody: "x=1", contentType: "application/x-www-form-urlencoded" });
    expect(r.status).toBe(500);
    expect(r.outcome).toMatch(/^unknown_status/);
  });
});

describe("L2：卡住的退款", () => {
  it("結果不明 → resolve_refund（需 confirm）標成功 → 訂單取消；requested 超過 15 分鐘 → cron 轉 unknown＋警示", async () => {
    const store = newStore();
    const s = await lpShop(store, "l2-rf");
    const a = await s.order();
    await s.pay(a.order, a.accessKey);
    const unknownProvider: PaymentProvider = { ...s.provider, refund: async () => ({ kind: "unknown", message: "timeout" }) };
    await refundOrder(ctxFor(store), { site: "l2-rf", orderNo: a.order.order_no, confirm: true }, async () => unknownProvider);
    const rf = (await store.listRefundsForOrder(s.tenant.id, a.order.id))[0]!;
    expect(rf.status).toBe("unknown");
    await expect(resolveRefund(ctxFor(store), { site: "l2-rf", refundId: rf.id, outcome: "succeeded" })).rejects.toMatchObject({ code: "confirm_required" });
    const r = await resolveRefund(ctxFor(store), { site: "l2-rf", refundId: rf.id, outcome: "succeeded", confirm: true });
    expect(r).toMatchObject({ status: "succeeded", orderCancelled: true });
    await expect(resolveRefund(ctxFor(store), { site: "l2-rf", refundId: rf.id, outcome: "failed", confirm: true })).rejects.toMatchObject({ code: "conflict" });

    const b = await s.order();
    const bp = await s.pay(b.order, b.accessKey);
    await store.insertRefund({ tenant_id: s.tenant.id, order_id: b.order.id, payment_id: bp.id, provider: "linepay", amount: b.order.total, requested_by: "test", reason: null });
    expect((await sweepStaleRefunds(s.deps, Date.now())).marked).toBe(0);
    const out = await sweepStaleRefunds(s.deps, Date.now() + 20 * 60_000);
    expect(out.marked).toBe(1);
    expect((await store.listRefundsForOrder(s.tenant.id, b.order.id))[0]!.status).toBe("unknown");
    expect(s.sent.some((m) => m.includes("退款結果不明"))).toBe(true);
  });
});

describe("L4：手動調整上限", () => {
  it("每日上限原子：5 個同時送出的 5,000 點（上限 20,000）只成功 4 個；模組設定不能調高；只有平台後台能改", async () => {
    const store = newStore();
    const shop = await makeShop(store, "l4-adj");
    await enableModule(shop.ctx, { site: "l4-adj", moduleId: "loyalty", config: {} });
    await configureModule(shop.ctx, { site: "l4-adj", moduleId: "loyalty", config: { adjustMaxPerCall: 999_999, adjustMaxPerDay: 9_999_999 } });
    await publishSite(shop.ctx, { site: "l4-adj", confirm: true });
    const m = (await store.insertMember({ tenant_id: shop.tenant.id, email: "adj@example.com", password_hash: "x", name: null, phone: null }))!;
    await expect(adjustPoints(ctxFor(store), { site: "l4-adj", memberId: m.id, amount: 6000, reason: "測試", confirm: true })).rejects.toThrow(/單次調整上限 5000/);
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => adjustPoints(ctxFor(store), { site: "l4-adj", memberId: m.id, amount: 5000, reason: "併發", confirm: true })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(4);
    expect((await store.creditState("points", shop.tenant.id, m.id)).balance).toBe(20_000);
    const tenantActor = { ...ctxFor(store), actor: { kind: "token" as const, tenantId: shop.tenant.id, scopes: ["points:adjust"], label: "t" } } as never;
    await expect(setAdjustLimits(tenantActor, { site: "l4-adj", ledger: "points", perCall: 100000, perDay: 1000000 })).rejects.toMatchObject({ code: "forbidden" });
    await setAdjustLimits(ctxFor(store), { site: "l4-adj", ledger: "points", perCall: 8000, perDay: 30000 });
    expect((await adjustPoints(ctxFor(store), { site: "l4-adj", memberId: m.id, amount: 8000, reason: "新上限", confirm: true })).adjusted).toBe(8000);
  });
});
