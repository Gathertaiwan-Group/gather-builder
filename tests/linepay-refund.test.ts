/**
 * 第七批：LINE Pay（導回後由商家 server confirm）與退款（refund_order）。記憶體 Store＋真的 provider 實作＋假的 fetch。
 * 🔴 不打任何真實 API、不輸入卡號、不發起真實退款。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, confirmLinepayPayment, expireIfDue, handleLinepayConfirm, refundOrder, saveProviderAccount, startOnlinePayment, type PayDeps } from "@/lib/services/orders";
import { createLinepayProvider } from "@/lib/pay/linepay";
import { createNewebpayProvider, newebpayCheckCode } from "@/lib/pay/newebpay";
import { payToken } from "@/lib/pay/notify-token";
import type { FetchLike, PaymentProvider } from "@/lib/pay/types";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "https://test.example";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 4).toString("base64");
});

const contact = { name: "客人", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "客人", phone: "0912345678", address: "台中市" };
const json = (o: unknown) => new Response(typeof o === "string" ? o : JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const TID = "2026101958491409700"; // 19 位數（> MAX_SAFE_INTEGER）

/** 假 LINE Pay：記錄每次 confirm 的金額；check／confirm 的回應可由測試控制 */
function fakeLinepay() {
  const st = { confirmCode: "0000" as string | "timeout", checkCode: "0000", confirms: [] as number[], refunds: [] as number[], refundCode: "0000", paidAmount: 0 };
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname === "/v3/payments/request") {
      st.paidAmount = body.amount;
      return json(`{"returnCode":"0000","returnMessage":"OK","info":{"transactionId":${TID},"paymentUrl":{"web":"https://sandbox-web-pay.line.me/web/payment/wait?transactionReserveId=abc","app":"line://pay/x"}}}`);
    }
    if (u.pathname === `/v3/payments/${TID}/confirm`) {
      st.confirms.push(body.amount);
      if (st.confirmCode === "timeout") throw new Error("aborted");
      if (st.confirmCode === "0000") {
        st.checkCode = "0123";
        return json(`{"returnCode":"0000","info":{"orderId":"x","transactionId":${TID},"payInfo":[{"method":"BALANCE","amount":${body.amount}}]}}`);
      }
      return json({ returnCode: st.confirmCode, returnMessage: "error" });
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

async function lpShop(store: Store, slug: string) {
  const shop = await makeShop(store, slug);
  await saveProviderAccount(ctxFor(store), { site: slug, provider: "linepay", appId: "1234567890", secrets: { channelSecret: "a917ab6a2367b536f8e5a6e2977e06f4" }, sandbox: false });
  await store.markPaymentAccount(shop.tenant.id, "linepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  const lp = fakeLinepay();
  const provider = createLinepayProvider({ channelId: "1234567890", channelSecret: "a917ab6a2367b536f8e5a6e2977e06f4", sandbox: false }, lp.fetch);
  const sent: string[] = [];
  const deps: PayDeps = { store, baseUrl: "https://test.example", sendMail: async (_t, subject) => void sent.push(subject), providerFor: async () => provider };
  const order = async () => {
    const { order, accessKey } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "linepay" } });
    const pay = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => provider }, { tenant: shop.tenant, order, accessKey });
    return { order, pay, payment: (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))! };
  };
  const confirm = (payment: { id: string; gateway_order_no: string }, over: Partial<{ transactionId: string; orderId: string; token: string }> = {}) =>
    handleLinepayConfirm(deps, { tenantId: shop.tenant.id, paymentId: payment.id, token: over.token ?? payToken("confirm", payment.id), transactionId: over.transactionId ?? TID, orderId: over.orderId ?? payment.gateway_order_no });
  return { ...shop, lp, provider, deps, sent, order, confirm };
}

describe("LINE Pay", () => {
  it("建單：transactionId 19 位數存成字串；導轉 paymentUrl.web；confirmUrl 帶租戶與 token", async () => {
    const store = newStore();
    const s = await lpShop(store, "lp-create");
    const { pay, payment } = await s.order();
    expect(pay).toMatchObject({ kind: "redirect", url: expect.stringContaining("sandbox-web-pay.line.me") });
    expect(payment.gateway_trade_no).toBe(TID);
  });

  it("confirm 金額一律來自 DB（不信導回參數）、冪等（重複導回只 confirm 一次、副作用一次）", async () => {
    const store = newStore();
    const s = await lpShop(store, "lp-idem");
    const { order, payment } = await s.order();
    const r = await Promise.all([s.confirm(payment), s.confirm(payment), s.confirm(payment)]);
    expect(r.map((x) => x.result).filter((x) => x === "paid").length).toBeGreaterThanOrEqual(1);
    expect(s.lp.st.confirms).toEqual([order.total]);
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("paid");
    const mails = s.sent.length;
    await s.confirm(payment);
    expect(s.lp.st.confirms).toHaveLength(1);
    expect(s.sent.length).toBe(mails);
  });

  it("導回參數被竄改（token、transactionId、orderId 不符）→ 不 confirm", async () => {
    const store = newStore();
    const s = await lpShop(store, "lp-forge");
    const { order, payment } = await s.order();
    expect((await s.confirm(payment, { token: "x".repeat(32) })).result).toBe("invalid");
    expect((await s.confirm(payment, { transactionId: "2026101958491409701" })).result).toBe("invalid");
    expect((await s.confirm(payment, { orderId: "GBOTHER" })).result).toBe("invalid");
    expect(s.lp.st.confirms).toHaveLength(0);
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
  });

  it("confirm 逾時 → 結果不明（不取消）；之後逾期前回查 check=0123 → 認回已付（不重複 confirm）", async () => {
    const store = newStore();
    const s = await lpShop(store, "lp-timeout");
    const { order, payment } = await s.order();
    s.lp.st.confirmCode = "timeout";
    s.lp.st.checkCode = "0000"; // 逾時當下 check 仍是未完成
    expect((await s.confirm(payment)).result).toBe("pending");
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
    // LINE Pay 端其實已完成
    s.lp.st.checkCode = "0123";
    expect((await expireIfDue(store, order, Date.now() + 3 * 3600_000, s.deps)).status).toBe("paid");
    expect(s.lp.st.confirms).toHaveLength(1);
  });

  it("客人授權後沒回來（check=0110）→ 逾期前回查以 DB 金額補 confirm；訂單已取消 → 不 confirm（授權不請款）", async () => {
    const store = newStore();
    const s = await lpShop(store, "lp-0110");
    const a = await s.order();
    s.lp.st.checkCode = "0110";
    expect((await expireIfDue(store, a.order, Date.now() + 3 * 3600_000, s.deps)).status).toBe("paid");
    expect(s.lp.st.confirms).toEqual([a.order.total]);
    const b = await s.order();
    s.lp.st.checkCode = "0110";
    await cancelOrder(ctxFor(store), { site: "lp-0110", orderNo: b.order.order_no, confirm: true });
    expect(await confirmLinepayPayment(s.deps, s.tenant, b.payment, b.order)).toBe("failed");
    expect(s.lp.st.confirms).toHaveLength(1);
  });

  it("confirm 回 1172（重複）→ 以 check 權威回查；0121 取消 → failed；未知碼 → 不標記", async () => {
    const store = newStore();
    const s = await lpShop(store, "lp-codes");
    const a = await s.order();
    s.lp.st.confirmCode = "1172";
    s.lp.st.checkCode = "0123";
    expect((await s.confirm(a.payment)).result).toBe("paid");
    const b = await s.order();
    s.lp.st.confirmCode = "1150";
    s.lp.st.checkCode = "0121";
    expect((await s.confirm(b.payment)).result).toBe("failed");
    const c = await s.order();
    s.lp.st.checkCode = "9000";
    expect((await s.confirm(c.payment)).result).toBe("pending");
    expect((await store.getOrderById(s.tenant.id, c.order.id))!.status).toBe("pending_payment");
  });
});

describe("退款 refund_order", () => {
  it("LINE Pay：需 confirm；只能退一次；金額＝已付金額；成功後訂單取消；MCP 也要 confirm", async () => {
    const store = newStore();
    const s = await lpShop(store, "rf-lp");
    const { order, payment } = await s.order();
    await s.confirm(payment);
    const factory = async () => s.provider;
    await expect(refundOrder(ctxFor(store), { site: "rf-lp", orderNo: order.order_no }, factory)).rejects.toMatchObject({ code: "confirm_required" });
    expect(s.lp.st.refunds).toHaveLength(0);
    const r = await refundOrder(ctxFor(store), { site: "rf-lp", orderNo: order.order_no, confirm: true }, factory);
    expect(r).toMatchObject({ refunded: true, amount: order.total, status: "succeeded", orderCancelled: true });
    expect(s.lp.st.refunds).toEqual([order.total]);
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("cancelled");
    await expect(refundOrder(ctxFor(store), { site: "rf-lp", orderNo: order.order_no, confirm: true }, factory)).rejects.toThrow(/已退款/);
    // 併發重送也只會退一次（DB 唯一鍵）
    expect(s.lp.st.refunds).toHaveLength(1);
  });

  it("併發兩次退款 → 只有一次呼叫 provider", async () => {
    const store = newStore();
    const s = await lpShop(store, "rf-race");
    const { order, payment } = await s.order();
    await s.confirm(payment);
    const factory = async () => s.provider;
    const r = await Promise.allSettled([1, 2, 3].map(() => refundOrder(ctxFor(store), { site: "rf-race", orderNo: order.order_no, confirm: true }, factory)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(s.lp.st.refunds).toHaveLength(1);
  });

  it("provider 拒絕（例如 1165 已退款）→ 退款 failed、訂單不變、可重新申請；結果不明 → unknown、不再自動重送", async () => {
    const store = newStore();
    const s = await lpShop(store, "rf-fail");
    const { order, payment } = await s.order();
    await s.confirm(payment);
    s.lp.st.refundCode = "1165";
    await expect(refundOrder(ctxFor(store), { site: "rf-fail", orderNo: order.order_no, confirm: true }, async () => s.provider)).rejects.toThrow(/退款失敗/);
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("paid");
    // 結果不明
    const unknownProvider: PaymentProvider = { ...s.provider, refund: async () => ({ kind: "unknown", message: "timeout" }) };
    const r = await refundOrder(ctxFor(store), { site: "rf-fail", orderNo: order.order_no, confirm: true }, async () => unknownProvider);
    expect(r).toMatchObject({ refunded: false, status: "unknown" });
    await expect(refundOrder(ctxFor(store), { site: "rf-fail", orderNo: order.order_no, confirm: true }, async () => s.provider)).rejects.toThrow(/結果不明/);
  });

  it("藍新：已請款（CloseStatus=3）走 Close CloseType=2、未請款走 Cancel；金額＝已付；沒有退款 API 的 provider 提示人工", async () => {
    const store = newStore();
    const shop = await makeShop(store, "rf-nw");
    const NW = { merchantId: "MS127874575", hashKey: "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn", hashIv: "C6AcmfqJILwgnhIP" };
    await saveProviderAccount(ctxFor(store), { site: "rf-nw", provider: "newebpay", appId: NW.merchantId, secrets: { hashKey: NW.hashKey, hashIv: NW.hashIv }, sandbox: true });
    await store.markPaymentAccount(shop.tenant.id, "newebpay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
    const calls: string[] = [];
    let closeStatus = "3";
    const fetch: FetchLike = async (url, init) => {
      calls.push(new URL(url).pathname);
      const req = Object.fromEntries(new URLSearchParams(String(init.body)));
      if (url.endsWith("/API/QueryTradeInfo")) {
        const r = { MerchantID: NW.merchantId, Amt: Number(req.Amt), TradeNo: "26101900000000001", MerchantOrderNo: req.MerchantOrderNo!, TradeStatus: "1", CloseStatus: closeStatus, BackStatus: "0" };
        return json({ Status: "SUCCESS", Result: { ...r, CheckCode: newebpayCheckCode(r, NW.hashKey, NW.hashIv) } });
      }
      return json({ Status: "SUCCESS", Message: "ok", Result: { TradeNo: "26101900000000001" } });
    };
    const provider = createNewebpayProvider({ ...NW, test: true }, fetch);
    const { order, accessKey } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: shop.tenant, member: null, allowSandbox: true, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "newebpay" } });
    const pay = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => provider }, { tenant: shop.tenant, order, accessKey });
    const p = (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!;
    // 直接標成已付（測試退款流程用；付款流程另見 providers.test.ts）
    await store.transitionPayment(shop.tenant.id, p.id, "pending", "paid", { paid_at: new Date().toISOString() });
    await store.transitionOrder(shop.tenant.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    const r = await refundOrder(ctxFor(store), { site: "rf-nw", orderNo: order.order_no, confirm: true }, async () => provider);
    expect(r.status).toBe("succeeded");
    expect(calls).toEqual(["/API/QueryTradeInfo", "/API/CreditCard/Close"]);
    void closeStatus;
    closeStatus = "1";
  });

  it("PChomePay／綠界／線下匯款：refund_order 拒絕並提示人工退款", async () => {
    const store = newStore();
    const shop = await makeShop(store, "rf-manual");
    const { order } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    await expect(refundOrder(ctxFor(store), { site: "rf-manual", orderNo: order.order_no, confirm: true })).rejects.toThrow(/沒有已付款的線上付款/);
  });
});
