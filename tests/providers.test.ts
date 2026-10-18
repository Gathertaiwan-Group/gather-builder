/**
 * 第七批：藍新／綠界／PAYUNi／黑貓 的 server 通知安全規則（記憶體 Store＋真的 provider 實作＋假的 fetch）。
 * 每一家都跑同一組情境：偽造通知（簽章對但回查未付）、金額不符、租戶不符、簽章竄改、重複／遲到通知只觸發一次副作用、
 * 已取消後才付款、無法辨識的狀態不回成功、回查失敗要求重送、逾期前回查、sandbox 只限預覽。
 * callback 用「官方公開測試金鑰／文件範例金鑰」自己正確簽章；回查回應由假 fetch 依官方格式組出（含回應簽章）。🔴 不打任何真實 API。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, expireIfDue, fulfillOrder, handleProviderNotify, saveProviderAccount, startOnlinePayment, type PayDeps } from "@/lib/services/orders";
import { aesCbcEncryptHex, aesGcmEncryptHex, buildQuery } from "@/lib/pay/crypto";
import { ECPAY_STAGE_TEST_MERCHANT, createEcpayProvider, ecpayCheckMac } from "@/lib/pay/ecpay";
import { createNewebpayProvider, newebpayCheckCode, newebpayTradeSha } from "@/lib/pay/newebpay";
import { createPayuniProvider, payuniHashInfo } from "@/lib/pay/payuni";
import { blackcatApnChecksum, clearBlackcatTokenCache, createBlackcatProvider } from "@/lib/pay/blackcat";
import { payToken } from "@/lib/pay/notify-token";
import type { FetchLike, PaymentProvider } from "@/lib/pay/types";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "https://test.example";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 3).toString("base64");
});

const contact = { name: "客人", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "客人", phone: "0912345678", address: "台中市" };

type QState = { state: "paid" | "pending" | "failed" | "weird" | "error"; amount: number };
type Prov = "ecpay" | "newebpay" | "payuni" | "blackcat";

/** 每一家：測試憑證、假 fetch（依 q 回應官方格式）、組一則正確簽章的付款成功通知 */
interface Harness {
  provider: Prov;
  appId: string;
  secrets: Record<string, string>;
  make(fetch: FetchLike): PaymentProvider;
  fetch(q: { current: QState }): FetchLike;
  callback(gatewayOrderNo: string, amount: number, opts?: { tamper?: boolean }): { body: string; contentType: string };
  okBody: string;
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// 綠界：官方公開測試特店 3002607（https://developers.ecpay.com.tw/2856/）
const EC = ECPAY_STAGE_TEST_MERCHANT;
// 藍新：NDNF 手冊範例金鑰（文件公開範例值，非真實商店）
const NW = { merchantId: "MS127874575", hashKey: "Fs5cX1TGqYM2PpdbE14a9H83YQSQF5jn", hashIv: "C6AcmfqJILwgnhIP" };
// PAYUNi：官方文件範例 Key／IV（https://docs.payuni.com.tw/web/#/7/29）
const PU = { merId: "AAA", hashKey: "12345678901234567890123456789012", hashIv: "1234567890123456" };
// 黑貓：規格書 APN 範例 api_id；密碼為假值（測試只走假 fetch）
const BC = { custId: "CC0000000001", apiPassword: "fake-password" };

const harnesses: Harness[] = [
  {
    provider: "ecpay",
    appId: EC.merchantId,
    secrets: { hashKey: EC.hashKey, hashIv: EC.hashIv },
    make: (f) => createEcpayProvider({ merchantId: EC.merchantId, hashKey: EC.hashKey, hashIv: EC.hashIv, stage: false }, f),
    fetch: (q) => async (url, init) => {
      if (!url.includes("QueryTradeInfo")) throw new Error(`unexpected ${url}`);
      if (q.current.state === "error") throw new Error("network down");
      const req = Object.fromEntries(new URLSearchParams(String(init.body)));
      const ts = { paid: "1", pending: "0", failed: "10200095", weird: "77777" }[q.current.state];
      const p: Record<string, string> = { MerchantID: EC.merchantId, MerchantTradeNo: req.MerchantTradeNo!, TradeNo: "2410191234567890", TradeAmt: String(q.current.amount), PaymentDate: "2026/10/19 12:00:00", PaymentType: "Credit_CreditCard", TradeStatus: ts!, StoreID: "", CustomField1: "" };
      const body = Object.entries({ ...p, CheckMacValue: ecpayCheckMac(p, EC.hashKey, EC.hashIv) }).map(([k, v]) => `${k}=${v}`).join("&");
      return new Response(body, { status: 200 });
    },
    callback: (no, amount, o = {}) => {
      const p: Record<string, string> = { MerchantID: EC.merchantId, MerchantTradeNo: no, RtnCode: "1", RtnMsg: "交易成功", TradeAmt: String(amount), TradeNo: "2410191234567890", PaymentType: "Credit_CreditCard", SimulatePaid: "0", CustomField1: "" };
      const mac = ecpayCheckMac(p, EC.hashKey, EC.hashIv);
      return { body: new URLSearchParams({ ...p, CheckMacValue: o.tamper ? mac.replace(/^./, mac[0] === "A" ? "B" : "A") : mac }).toString(), contentType: "application/x-www-form-urlencoded" };
    },
    okBody: "1|OK",
  },
  {
    provider: "newebpay",
    appId: NW.merchantId,
    secrets: { hashKey: NW.hashKey, hashIv: NW.hashIv },
    make: (f) => createNewebpayProvider({ ...NW, test: false }, f),
    fetch: (q) => async (url, init) => {
      if (!url.includes("QueryTradeInfo")) throw new Error(`unexpected ${url}`);
      if (q.current.state === "error") throw new Error("network down");
      const req = Object.fromEntries(new URLSearchParams(String(init.body)));
      if (q.current.state === "pending") return json({ Status: "TRA10021", Message: "查無交易", Result: [] });
      const ts = { paid: "1", failed: "2", weird: "6" }[q.current.state as "paid"];
      const r = { MerchantID: NW.merchantId, Amt: q.current.amount, TradeNo: "26101912345678901", MerchantOrderNo: req.MerchantOrderNo!, TradeStatus: ts, PaymentType: "CREDIT", CloseStatus: "0", BackStatus: "0" };
      return json({ Status: "SUCCESS", Message: "查詢成功", Result: { ...r, CheckCode: newebpayCheckCode(r, NW.hashKey, NW.hashIv) } });
    },
    callback: (no, amount, o = {}) => {
      const ti = aesCbcEncryptHex(JSON.stringify({ Status: "SUCCESS", Message: "授權成功", Result: { MerchantID: NW.merchantId, Amt: amount, TradeNo: "26101912345678901", MerchantOrderNo: no, PaymentType: "CREDIT" } }), NW.hashKey, NW.hashIv);
      const sha = newebpayTradeSha(ti, NW.hashKey, NW.hashIv);
      return { body: new URLSearchParams({ Status: "SUCCESS", MerchantID: NW.merchantId, Version: "2.0", TradeInfo: ti, TradeSha: o.tamper ? sha.replace(/.$/, sha.endsWith("0") ? "1" : "0") : sha }).toString(), contentType: "application/x-www-form-urlencoded" };
    },
    okBody: "SUCCESS",
  },
  {
    provider: "payuni",
    appId: PU.merId,
    secrets: { hashKey: PU.hashKey, hashIv: PU.hashIv },
    make: (f) => createPayuniProvider({ ...PU, sandbox: false }, f),
    fetch: (q) => async (url, init) => {
      if (!url.includes("/api/trade/query")) throw new Error(`unexpected ${url}`);
      if (q.current.state === "error") throw new Error("network down");
      const outer = Object.fromEntries(new URLSearchParams(String(init.body)));
      const dec = (await import("@/lib/pay/crypto")).aesGcmDecryptHex(outer.EncryptInfo!, PU.hashKey, PU.hashIv);
      const no = new URLSearchParams(dec).get("MerTradeNo")!;
      const inner =
        q.current.state === "pending"
          ? buildQuery({ Status: "QUERY03001", Message: "查無符合訂單資料" })
          : buildQuery({ Status: "SUCCESS", Message: "查詢成功", "Result[0][MerTradeNo]": no, "Result[0][TradeNo]": "UNI123", "Result[0][TradeAmt]": q.current.amount, "Result[0][TradeStatus]": { paid: "1", failed: "2", weird: "5" }[q.current.state as "paid"], "Result[0][DataSource]": "A", "Result[0][CloseStatus]": "9" });
      const e = aesGcmEncryptHex(inner, PU.hashKey, PU.hashIv);
      return json({ Status: q.current.state === "pending" ? "QUERY03001" : "SUCCESS", MerID: PU.merId, Version: "2.0", EncryptInfo: e, HashInfo: payuniHashInfo(e, PU.hashKey, PU.hashIv) });
    },
    callback: (no, amount, o = {}) => {
      const e = aesGcmEncryptHex(buildQuery({ Status: "SUCCESS", MerID: PU.merId, MerTradeNo: no, TradeNo: "UNI123", TradeAmt: amount, TradeStatus: 1, PaymentType: 1 }), PU.hashKey, PU.hashIv);
      const h = payuniHashInfo(e, PU.hashKey, PU.hashIv);
      return { body: new URLSearchParams({ Status: "SUCCESS", MerID: PU.merId, Version: "2.0", EncryptInfo: e, HashInfo: o.tamper ? h.replace(/^./, h[0] === "A" ? "B" : "A") : h }).toString(), contentType: "application/x-www-form-urlencoded" };
    },
    okBody: "OK",
  },
  {
    provider: "blackcat",
    appId: BC.custId,
    secrets: { apiPassword: BC.apiPassword },
    make: (f) => createBlackcatProvider({ custId: BC.custId, apiPassword: BC.apiPassword, test: false, cacheKey: `t-${Math.random()}` }, f),
    fetch: (q) => async (url, init) => {
      if (url.endsWith("/Token")) return json({ access_token: "tok", ".expires": new Date(Date.now() + 3600_000).toUTCString() });
      if (!url.endsWith("/api/Collect")) throw new Error(`unexpected ${url}`);
      if (q.current.state === "error") throw new Error("network down");
      const req = JSON.parse(String(init.body)) as Record<string, unknown>;
      const code = { paid: 15, pending: 13, failed: 16, weird: 23 }[q.current.state as "paid"];
      // 🔴 order_amount 只是念回我們送的金額；grant_amount 是扣手續費的淨額（故意給不同值，確保沒被拿來比對）
      return json({ status: "OK", cust_order_no: req.cust_order_no, process_code: code, order_amount: q.current.amount, grant_amount: q.current.amount - 40 });
    },
    callback: (no, amount, o = {}) => {
      const b = { api_id: BC.custId, trans_id: "550e8400e29b41d4a716446655440000", order_no: no, amount: String(amount), status: "B", nonce: String(Date.now()), payment_detail: { pay_amount: amount, fee: null } };
      const checksum = blackcatApnChecksum({ api_id: b.api_id, trans_id: b.trans_id, amount: b.amount, status: b.status, nonce: b.nonce });
      return { body: JSON.stringify({ ...b, checksum: o.tamper ? checksum.replace(/^./, checksum[0] === "a" ? "b" : "a") : checksum }), contentType: "application/json" };
    },
    okBody: "OK",
  },
];

async function setup(store: Store, h: Harness, slug: string, opts: { sandbox?: boolean } = {}) {
  clearBlackcatTokenCache();
  const shop = await makeShop(store, slug);
  await saveProviderAccount(ctxFor(store), { site: slug, provider: h.provider, appId: h.appId, secrets: h.secrets, sandbox: !!opts.sandbox });
  await store.markPaymentAccount(shop.tenant.id, h.provider, { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  const q = { current: { state: "pending", amount: 0 } as QState };
  const fetch = h.fetch(q);
  const provider = h.make(fetch);
  const sent: { to: string; subject: string }[] = [];
  const deps: PayDeps = { store, baseUrl: "https://test.example", sendMail: async (to, subject) => void sent.push({ to, subject }), providerFor: async () => provider };
  const order = async (allowSandbox = false) => {
    const { order, accessKey } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: shop.tenant, member: null, allowSandbox, data: { items: [{ productId: shop.mug.id, qty: 2 }], contact, shipping, paymentMethod: h.provider } });
    const pay = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => provider }, { tenant: shop.tenant, order, accessKey });
    const payment = (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!;
    return { order, accessKey, pay, payment };
  };
  const notify = (payment: { id: string; gateway_order_no: string }, amount: number, o: { tamper?: boolean; tenantId?: string } = {}) => {
    const cb = h.callback(payment.gateway_order_no, amount, o);
    return handleProviderNotify(deps, { provider: h.provider, tenantId: o.tenantId ?? shop.tenant.id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody: cb.body, contentType: cb.contentType });
  };
  return { ...shop, q, deps, sent, order, notify, provider };
}

for (const h of harnesses) {
  describe(`${h.provider}：notify 安全規則`, () => {
    it("建單：導轉或表單（金額、訂單號正確）；結帳頁正式憑證才顯示給訪客", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-create`);
      // 黑貓建單要打 API（假 fetch 不支援 CocsOrderAppend 時會失敗）→ 只驗證表單型 provider 的欄位
      if (h.provider === "blackcat") return;
      const { pay, order } = await s.order();
      expect(pay.kind).toBe("form");
      if (pay.kind !== "form") return;
      const fields = pay.fields;
      if (h.provider === "ecpay") {
        expect(fields).toMatchObject({ MerchantID: EC.merchantId, MerchantTradeNo: pay.gatewayOrderNo, TotalAmount: String(order.total), ChoosePayment: "Credit", EncryptType: "1", PaymentType: "aio" });
        expect(fields.ReturnURL).toMatch(new RegExp(`/api/pay/ecpay/notify/${s.tenant.id}\\?p=`));
        expect(fields.CheckMacValue).toBe(ecpayCheckMac(fields, EC.hashKey, EC.hashIv));
      }
      if (h.provider === "newebpay") {
        expect(fields.TradeSha).toBe(newebpayTradeSha(fields.TradeInfo!, NW.hashKey, NW.hashIv));
        const plain = (await import("@/lib/pay/crypto")).aesCbcDecryptHex(fields.TradeInfo!, NW.hashKey, NW.hashIv);
        expect(Object.fromEntries(new URLSearchParams(plain))).toMatchObject({ MerchantID: NW.merchantId, MerchantOrderNo: pay.gatewayOrderNo, Amt: String(order.total), CREDIT: "1", Version: "2.0" });
      }
      if (h.provider === "payuni") {
        expect(fields.HashInfo).toBe(payuniHashInfo(fields.EncryptInfo!, PU.hashKey, PU.hashIv));
        const plain = (await import("@/lib/pay/crypto")).aesGcmDecryptHex(fields.EncryptInfo!, PU.hashKey, PU.hashIv);
        expect(Object.fromEntries(new URLSearchParams(plain))).toMatchObject({ MerID: PU.merId, MerTradeNo: pay.gatewayOrderNo, TradeAmt: String(order.total), Credit: "1" });
      }
    });

    if (h.provider === "blackcat") return; // 黑貓的建單需要 API，另見下方黑貓專屬測試

    it("偽造通知（簽章正確、自稱已付）但回查未付 → 不改狀態、不寄信", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-forge`);
      const { order, payment } = await s.order();
      s.q.current = { state: "pending", amount: order.total };
      const r = await s.notify(payment, order.total);
      expect(r).toMatchObject({ status: 200, body: h.okBody });
      expect(r.outcome).toMatch(/^not_paid/);
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
      expect(s.sent).toHaveLength(0);
    });

    it("簽章竄改 → 拒絕（不回查、不改狀態）；token 錯 → 拒絕", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-tamper`);
      const { order, payment } = await s.order();
      s.q.current = { state: "paid", amount: order.total };
      const r = await s.notify(payment, order.total, { tamper: true });
      expect(r.outcome).toMatch(/^signature:/);
      expect(r.body).not.toBe(h.okBody);
      const cb = h.callback(payment.gateway_order_no, order.total);
      const r2 = await handleProviderNotify(s.deps, { provider: h.provider, tenantId: s.tenant.id, paymentId: payment.id, token: "x".repeat(32), rawBody: cb.body, contentType: cb.contentType });
      expect(r2.outcome).toBe("bad_token");
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
    });

    it("回查已付但金額不符 → 不標記", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-amount`);
      const { order, payment } = await s.order();
      s.q.current = { state: "paid", amount: order.total - 1 };
      const r = await s.notify(payment, order.total);
      expect(r.outcome).toBe("amount_mismatch");
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
    });

    it("租戶不符（通知打到別的租戶路徑）→ 不改狀態", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-tenant`);
      const other = await setup(store, h, `${h.provider}-tenant2`);
      const { order, payment } = await s.order();
      s.q.current = { state: "paid", amount: order.total };
      other.q.current = { state: "paid", amount: order.total };
      const cb = h.callback(payment.gateway_order_no, order.total);
      const r = await handleProviderNotify(other.deps, { provider: h.provider, tenantId: other.tenant.id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody: cb.body, contentType: cb.contentType });
      expect(r.outcome).toBe("unknown_payment");
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
    });

    it("正常付款：轉 paid、寄信一次；重複／遲到通知冪等（不重跑副作用、不覆蓋）", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-paid`);
      const { order, payment } = await s.order();
      s.q.current = { state: "paid", amount: order.total };
      const r = await s.notify(payment, order.total);
      expect(r).toMatchObject({ status: 200, body: h.okBody, outcome: "paid" });
      expect((await store.getOrderById(s.tenant.id, order.id))!).toMatchObject({ status: "paid", payment_sandbox: false });
      const mails = s.sent.length;
      expect(mails).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) expect((await s.notify(payment, order.total)).outcome).toMatch(/^already/);
      // 遲到的「失敗」回查也不會覆蓋已付款
      s.q.current = { state: "failed", amount: order.total };
      await s.notify(payment, order.total);
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("paid");
      expect(s.sent.length).toBe(mails);
    });

    it("訂單已取消後才收到付款 → 不改訂單、付款標 paid_after_cancel、警示店主一次", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-late`);
      const { order, payment } = await s.order();
      await cancelOrder(ctxFor(store), { site: `${h.provider}-late`, orderNo: order.order_no, confirm: true });
      s.q.current = { state: "paid", amount: order.total };
      expect((await s.notify(payment, order.total)).outcome).toBe("paid_after_cancel");
      expect((await s.notify(payment, order.total)).outcome).toMatch(/^already/);
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("cancelled");
      expect((await store.listPaymentsForOrder(s.tenant.id, order.id))[0]!.status).toBe("paid_after_cancel");
      expect(s.sent.filter((m) => m.subject.includes("已取消的訂單收到付款"))).toHaveLength(1);
    });

    it("無法辨識的狀態 → 不標記、不回成功（要求重送）、警示店主；回查失敗 → 要求重送", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-weird`);
      const { order, payment } = await s.order();
      s.q.current = { state: "weird", amount: order.total };
      const r = await s.notify(payment, order.total);
      expect(r.outcome).toMatch(/^unknown_status/);
      expect(r.body).not.toBe(h.okBody);
      expect(s.sent.some((m) => m.subject.includes("無法確認"))).toBe(true);
      s.q.current = { state: "error", amount: order.total };
      const r2 = await s.notify(payment, order.total);
      expect(r2.outcome).toBe("query_failed");
      expect(r2.body).not.toBe(h.okBody);
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
    });

    it("回查為付款失敗 → 付款標 failed、訂單仍待付款（之後同一筆權威回查已付仍可認回）", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-fail`);
      const { order, payment } = await s.order();
      s.q.current = { state: "failed", amount: order.total };
      expect((await s.notify(payment, order.total)).outcome).toMatch(/^failed/);
      expect((await store.listPaymentsForOrder(s.tenant.id, order.id))[0]!.status).toBe("failed");
      s.q.current = { state: "paid", amount: order.total };
      expect((await s.notify(payment, order.total)).outcome).toBe("paid");
      expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("paid");
    });

    it("逾期取消前先回查：已付 → 不取消、轉 paid；回查失敗 → 這次不取消；未付 → 取消", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-expire`);
      const later = Date.now() + 3 * 3600_000;
      const a = await s.order();
      s.q.current = { state: "paid", amount: a.order.total };
      expect((await expireIfDue(store, a.order, later, s.deps)).status).toBe("paid");
      const b = await s.order();
      s.q.current = { state: "error", amount: b.order.total };
      expect((await expireIfDue(store, b.order, later, s.deps)).status).toBe("pending_payment");
      s.q.current = { state: "pending", amount: b.order.total };
      expect((await expireIfDue(store, b.order, later, s.deps)).status).toBe("cancelled");
    });

    it("sandbox 帳號：已發布網站訪客不能選；預覽可用；sandbox 付款訂單不能出貨", async () => {
      const store = newStore();
      const s = await setup(store, h, `${h.provider}-sbx`, { sandbox: true });
      await expect(placeOrder({ store, baseUrl: "https://test.example" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: h.provider } })).rejects.toThrow(/無法使用/);
      const sbxProvider = h.make(h.fetch(s.q));
      Object.defineProperty(sbxProvider, "sandbox", { value: true });
      const { order, accessKey } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: s.tenant, member: null, allowSandbox: true, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: h.provider } });
      const pay = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => sbxProvider }, { tenant: s.tenant, order, accessKey });
      const payment = (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!;
      expect(payment.sandbox).toBe(true);
      s.q.current = { state: "paid", amount: order.total };
      expect((await s.notify(payment, order.total)).outcome).toBe("paid");
      expect((await store.getOrderById(s.tenant.id, order.id))!).toMatchObject({ status: "paid", payment_sandbox: true });
      await expect(fulfillOrder(ctxFor(store), { site: `${h.provider}-sbx`, orderNo: order.order_no, confirm: true })).rejects.toThrow(/sandbox/);
    });
  });
}

describe("黑貓 PAY 專屬", () => {
  const h = harnesses.find((x) => x.provider === "blackcat")!;
  async function bcSetup(store: Store, slug: string) {
    const s = await setup(store, h, slug);
    const appended: Record<string, unknown>[] = [];
    const base = h.fetch(s.q);
    const fetch: FetchLike = async (url, init) => {
      const b = init.body ? (JSON.parse(String(init.body).startsWith("{") ? String(init.body) : "{}") as Record<string, unknown>) : {};
      if (url.endsWith("/api/Collect") && b.cmd === "CocsOrderAppend") {
        appended.push(b);
        return json({ status: "OK", url: "https://cocs.4128888card.com.tw/pay/xyz", cust_order_no: b.cust_order_no });
      }
      return base(url, init);
    };
    const provider = h.make(fetch);
    s.deps.providerFor = async () => provider;
    const order = async () => {
      const { order, accessKey } = await placeOrder({ store, baseUrl: "https://test.example" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 2 }], contact, shipping, paymentMethod: "blackcat" } });
      const pay = await startOnlinePayment({ store, baseUrl: "https://test.example", providerFactory: async () => provider }, { tenant: s.tenant, order, accessKey });
      return { order, pay, payment: (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))! };
    };
    return { ...s, order, appended };
  }

  it("建單打 CocsOrderAppend（apn_url 帶租戶與 token、https）→ 導轉刷卡頁", async () => {
    const store = newStore();
    const s = await bcSetup(store, "bc-create");
    const { order, pay } = await s.order();
    expect(pay).toMatchObject({ kind: "redirect", url: "https://cocs.4128888card.com.tw/pay/xyz" });
    expect(s.appended[0]).toMatchObject({ cmd: "CocsOrderAppend", cust_id: BC.custId, order_amount: order.total, acquirer_type: "payuni" });
    expect(String(s.appended[0]!.apn_url)).toMatch(new RegExp(`^https://test\\.example/api/pay/blackcat/notify/${s.tenant.id}\\?p=.+&t=.+`));
  });

  it("🔴 checksum 正確（可被偽造）但回查未授權 → 不改狀態", async () => {
    const store = newStore();
    const s = await bcSetup(store, "bc-forge");
    const { order, payment } = await s.order();
    s.q.current = { state: "pending", amount: order.total };
    const r = await s.notify(payment, order.total);
    expect(r).toMatchObject({ status: 200, body: "OK" });
    expect((await store.getOrderById(s.tenant.id, order.id))!.status).toBe("pending_payment");
  });

  it("🔴 金額只用 APN 的 payment_detail.pay_amount：回查已授權＋pay_amount 正確 → paid；pay_amount 不符 → 不標記（grant_amount 淨額不參與比對）", async () => {
    const store = newStore();
    const s = await bcSetup(store, "bc-amount");
    const a = await s.order();
    s.q.current = { state: "paid", amount: a.order.total };
    expect((await s.notify(a.payment, a.order.total - 10)).outcome).toBe("amount_mismatch");
    expect((await store.getOrderById(s.tenant.id, a.order.id))!.status).toBe("pending_payment");
    expect((await s.notify(a.payment, a.order.total)).outcome).toBe("paid");
    expect((await store.getOrderById(s.tenant.id, a.order.id))!.status).toBe("paid");
    // 重送（同狀態最多 3 次）冪等
    expect((await s.notify(a.payment, a.order.total)).outcome).toMatch(/^already/);
  });

  it("逾期前回查為已授權但沒有 APN 的實收金額 → 不取消、不標記、警示店主", async () => {
    const store = newStore();
    const s = await bcSetup(store, "bc-expire");
    const { order } = await s.order();
    s.q.current = { state: "paid", amount: order.total };
    expect((await expireIfDue(store, order, Date.now() + 3 * 3600_000, s.deps)).status).toBe("pending_payment");
    expect(s.sent.some((m) => m.subject.includes("無法確認"))).toBe(true);
  });

  it("APN 的 api_id 不是這個租戶 → 拒絕", async () => {
    const store = newStore();
    const s = await bcSetup(store, "bc-apiid");
    const { order, payment } = await s.order();
    const b = { api_id: "CC9999999999", trans_id: "t1", order_no: payment.gateway_order_no, amount: String(order.total), status: "B", nonce: "1" };
    const body = JSON.stringify({ ...b, checksum: blackcatApnChecksum(b), payment_detail: { pay_amount: order.total } });
    const r = await handleProviderNotify(s.deps, { provider: "blackcat", tenantId: s.tenant.id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody: body, contentType: "application/json" });
    expect(r.outcome).toBe("signature:api_id");
  });
});

describe("第七批審查修正（金流）", () => {
  it("M2：金額不符 → 警示店主（一次）；L8：綠界 callback SimulatePaid=1 → 不算已付", async () => {
    const h = harnesses.find((x) => x.provider === "ecpay")!;
    const store = newStore();
    const s = await setup(store, h, "rv-amount");
    const a = await s.order();
    s.q.current = { state: "paid", amount: a.order.total - 1 };
    await s.notify(a.payment, a.order.total);
    await s.notify(a.payment, a.order.total);
    expect(s.sent.filter((m) => m.subject.includes("無法確認"))).toHaveLength(1);
    const b = await s.order();
    s.q.current = { state: "paid", amount: b.order.total };
    const p: Record<string, string> = { MerchantID: EC.merchantId, MerchantTradeNo: b.payment.gateway_order_no, RtnCode: "1", TradeAmt: String(b.order.total), SimulatePaid: "1" };
    const body = new URLSearchParams({ ...p, CheckMacValue: ecpayCheckMac(p, EC.hashKey, EC.hashIv) }).toString();
    const r = await handleProviderNotify(s.deps, { provider: "ecpay", tenantId: s.tenant.id, paymentId: b.payment.id, token: payToken("notify", b.payment.id), rawBody: body, contentType: "application/x-www-form-urlencoded" });
    expect(r.outcome).toMatch(/^unknown_status/);
    expect((await store.getOrderById(s.tenant.id, b.order.id))!.status).toBe("pending_payment");
  });

  it("L10：逾期前也回查先前失敗的付款（客人重刷成功、通知遺失）→ 認回已付不取消", async () => {
    const h = harnesses.find((x) => x.provider === "newebpay")!;
    const store = newStore();
    const s = await setup(store, h, "rv-failed");
    const a = await s.order();
    s.q.current = { state: "failed", amount: a.order.total };
    await s.notify(a.payment, a.order.total);
    s.q.current = { state: "paid", amount: a.order.total };
    expect((await expireIfDue(store, a.order, Date.now() + 3 * 3600_000, s.deps)).status).toBe("paid");
  });
});
