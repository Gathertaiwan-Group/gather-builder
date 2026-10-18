/**
 * invoice 模組：格式驗證、自動開票冪等、中繼回非 Amego 格式＝可重試、作廢 vs 折讓分流、反查認回、憑證只能後台輸入。
 * 🔴 全部用假供應商或假 fetch，不呼叫任何真實發票 API。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule, configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import {
  autoIssueOnPaid,
  getInvoice,
  getInvoiceSetupStatus,
  issueInvoice,
  issueInvoiceForOrder,
  retryInvoice,
  saveInvoiceAccount,
  setInvoiceProviderFactoryForTests,
  verifyInvoiceAccount,
  voidInvoice,
} from "@/lib/services/invoices";
import { CERTIFICATE, LOVE_CODE, MOBILE_BARCODE, invoiceRequestSchema, isValidTaxId } from "@/lib/invoice/validate";
import { canVoidInPeriod, invoiceLines, taipeiYmd, type InvoiceProvider } from "@/lib/invoice/provider";
import { amegoSign, createAmegoProvider, parseAmegoResponse } from "@/lib/invoice/amego";
import { createMockProvider } from "@/lib/invoice/mock";
import type { Store } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 3).toString("base64");
});
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const contact = { name: "王小明", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "王小明", phone: "0912345678", address: "台中市" };

/** 假供應商：記錄呼叫次數，可指定每次回應 */
function fakeProvider(over: Partial<InvoiceProvider> = {}) {
  const calls = { issue: 0, query: 0, void: 0, allowance: 0 };
  const base = createMockProvider();
  const p: InvoiceProvider = {
    id: "mock",
    verify: base.verify,
    issue: async (i) => {
      calls.issue++;
      return over.issue ? over.issue(i) : base.issue(i);
    },
    query: async (no) => {
      calls.query++;
      return over.query ? over.query(no) : base.query(no);
    },
    void: async (i) => {
      calls.void++;
      return over.void ? over.void(i) : base.void(i);
    },
    allowance: async (i) => {
      calls.allowance++;
      return over.allowance ? over.allowance(i) : base.allowance(i);
    },
  };
  return { p, calls };
}

/** 建一個啟用 invoice（mock 憑證、已驗證）、有一張已付款訂單的商店 */
async function paidOrderShop(store: Store, slug: string, invoiceConfig: Record<string, unknown> = {}) {
  const shop = await makeShop(store, slug);
  await store.updateTenant(shop.tenant.id, { is_test: true });
  const ctx = ctxFor(store);
  await enableModule(ctx, { site: slug, moduleId: "invoice", config: { issueMode: "manual", ...invoiceConfig } });
  await saveInvoiceAccount(ctx, { site: slug, provider: "mock", sellerTaxId: "53912857", appKey: "" });
  await verifyInvoiceAccount(ctx, { site: slug });
  await publishSite(ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", invoice: { type: "mobile", carrier: "/abc+123" } } });
  return { ...shop, ctx, tenant, order };
}

describe("發票格式驗證", () => {
  it("統一編號檢查碼（含第 7 碼為 7 的特例）", () => {
    for (const ok of ["53912857", "28080623", "04595257", "22099131", "10458574", "10458575"]) expect(isValidTaxId(ok)).toBe(true);
    for (const bad of ["12345678", "53912858", "00000000", "1234567", "5391285A", ""]) expect(isValidTaxId(bad)).toBe(false);
  });
  it("手機條碼、自然人憑證、愛心碼", () => {
    expect(MOBILE_BARCODE.test("/ABC+123")).toBe(true);
    expect(MOBILE_BARCODE.test("/AB.-1Z9")).toBe(true);
    expect(MOBILE_BARCODE.test("ABC+1234")).toBe(false);
    expect(MOBILE_BARCODE.test("/abc+123")).toBe(false); // 正規式本身要求大寫（schema 會先轉大寫）
    expect(MOBILE_BARCODE.test("/ABC123")).toBe(false);
    expect(CERTIFICATE.test("AB12345678901234")).toBe(true);
    expect(CERTIFICATE.test("A123456789012345")).toBe(false);
    expect(LOVE_CODE.test("168")).toBe(true);
    expect(LOVE_CODE.test("8585858")).toBe(true);
    expect(LOVE_CODE.test("12")).toBe(false);
    expect(LOVE_CODE.test("12345678")).toBe(false);
    expect(LOVE_CODE.test("12a")).toBe(false);
    expect(invoiceRequestSchema.parse({ type: "mobile", carrier: "/abc+123" })).toEqual({ type: "mobile", carrier: "/ABC+123" });
    expect(invoiceRequestSchema.safeParse({ type: "b2b", taxId: "12345678", title: "公司" }).success).toBe(false);
    expect(invoiceRequestSchema.safeParse({ type: "b2b", taxId: "53912857", title: "" }).success).toBe(false);
    expect(invoiceRequestSchema.safeParse({ type: "donation", loveCode: "99" }).success).toBe(false);
  });
  it("結帳：invoice 啟用時發票資料存進訂單；格式錯誤擋下", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-checkout");
    expect(s.order.invoice_request).toEqual({ type: "mobile", carrier: "/ABC+123" });
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", invoice: { type: "b2b", taxId: "12345678", title: "X" } } })).rejects.toThrow(/統一編號/);
  });
  it("明細加總一定等於實收（運費、折扣、尾差）", () => {
    const lines = invoiceLines({ items: [{ name: "A", variant_label: null, qty: 2, unit_price: 100 }], shipping_fee: 60, discount_total: 50, total: 210 });
    expect(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)).toBe(210);
    expect(lines.map((l) => l.name)).toEqual(["A", "運費", "折扣"]);
  });
});

describe("開立冪等", () => {
  it("自動開立：同一訂單重複／併發觸發只開一張（DB 唯一＋宣告）", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-auto", { issueMode: "auto_on_paid" });
    const f = fakeProvider();
    restore = setInvoiceProviderFactoryForTests(async () => f.p);
    await markOrderPaid(s.ctx, { site: "inv-auto", orderNo: s.order.order_no, confirm: true }); // onOrderPaid → autoIssueOnPaid
    const paid = (await store.getOrderById(s.tenant.id, s.order.id))!;
    await Promise.all(Array.from({ length: 5 }, () => autoIssueOnPaid(store, s.tenant, paid)));
    await issueInvoice(s.ctx, { site: "inv-auto", orderNo: s.order.order_no, confirm: true });
    expect(f.calls.issue).toBe(1);
    expect((await store.listInvoices(s.tenant.id, { limit: 10, offset: 0 })).total).toBe(1);
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.invoice_status).toBe("issued");
  });

  it("預設手動：付款成功不會自動開；issue_invoice 需要 confirm 與 invoices:write", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-manual");
    const f = fakeProvider();
    restore = setInvoiceProviderFactoryForTests(async () => f.p);
    await markOrderPaid(s.ctx, { site: "inv-manual", orderNo: s.order.order_no, confirm: true });
    expect(f.calls.issue).toBe(0);
    await expect(issueInvoice(s.ctx, { site: "inv-manual", orderNo: s.order.order_no })).rejects.toMatchObject({ code: "confirm_required" });
    const ro: Actor = { kind: "token", label: "t", tenantId: s.tenant.id, scopes: ["orders:read", "orders:write"] };
    await expect(issueInvoice(ctxFor(store, ro), { orderNo: s.order.order_no, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    const r = await issueInvoice(s.ctx, { site: "inv-manual", orderNo: s.order.order_no, confirm: true });
    expect(r.status).toBe("issued");
    expect(r.invoiceNo).toMatch(/^MK\d{8}$/);
  });

  it("未付款、sandbox 付款的訂單不能開票", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-unpaid");
    await expect(issueInvoice(s.ctx, { site: "inv-unpaid", orderNo: s.order.order_no, confirm: true })).rejects.toThrow(/尚未付款/);
    await store.transitionOrder(s.tenant.id, s.order.id, "pending_payment", "paid", { paid_at: new Date().toISOString(), payment_sandbox: true });
    await expect(issueInvoice(s.ctx, { site: "inv-unpaid", orderNo: s.order.order_no, confirm: true })).rejects.toThrow(/測試環境/);
  });

  it("第 2 次嘗試一定先反查：供應商已開過 → 認回，不重開", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-recover");
    await markOrderPaid(s.ctx, { site: "inv-recover", orderNo: s.order.order_no, confirm: true });
    const order = (await store.getOrderById(s.tenant.id, s.order.id))!;
    // 第 1 次：供應商其實開成功了，但回應遺失（逾時）
    const first = fakeProvider({ issue: async () => ({ ok: false, retryable: true, message: "連線失敗：timeout" }) });
    restore = setInvoiceProviderFactoryForTests(async () => first.p);
    expect((await issueInvoiceForOrder(store, s.tenant, order, "t")).status).toBe("failed");
    restore();
    const second = fakeProvider({ query: async () => ({ ok: true, found: true, invoiceNo: "AB12345678", randomNumber: "1234", invoiceDate: taipeiYmd(), raw: {} }) });
    restore = setInvoiceProviderFactoryForTests(async () => second.p);
    const r = await retryInvoice(s.ctx, { site: "inv-recover", orderNo: order.order_no, confirm: true });
    expect(r.invoiceNo).toBe("AB12345678");
    expect(second.calls.query).toBe(1);
    expect(second.calls.issue).toBe(0);
  });

  it("反查失敗（無法確認）→ 這次不開立，保持可重試", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-unknown");
    await markOrderPaid(s.ctx, { site: "inv-unknown", orderNo: s.order.order_no, confirm: true });
    const order = (await store.getOrderById(s.tenant.id, s.order.id))!;
    restore = setInvoiceProviderFactoryForTests(async () => fakeProvider({ issue: async () => ({ ok: false, retryable: true, message: "timeout" }) }).p);
    await issueInvoiceForOrder(store, s.tenant, order, "t");
    restore();
    const f = fakeProvider({ query: async () => ({ ok: false, retryable: true, message: "反查連線失敗" }) });
    restore = setInvoiceProviderFactoryForTests(async () => f.p);
    const r = await issueInvoiceForOrder(store, s.tenant, order, "t");
    expect(r.status).toBe("failed");
    expect(f.calls.issue).toBe(0);
    expect(r.invoice.error).toMatch(/可重試/);
  });

  it("OrderId 重複（供應商說已開過）→ 反查認回", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-dup");
    await markOrderPaid(s.ctx, { site: "inv-dup", orderNo: s.order.order_no, confirm: true });
    const f = fakeProvider({
      issue: async () => ({ ok: false, retryable: false, duplicate: true, message: "OrderId 重複" }),
      query: async () => ({ ok: true, found: true, invoiceNo: "CD87654321", randomNumber: null, invoiceDate: taipeiYmd(), raw: {} }),
    });
    restore = setInvoiceProviderFactoryForTests(async () => f.p);
    const r = await issueInvoice(s.ctx, { site: "inv-dup", orderNo: s.order.order_no, confirm: true });
    expect(r.invoiceNo).toBe("CD87654321");
  });
});

describe("Amego adapter（假 fetch，不連網）", () => {
  it("中繼／WAF 回非 Amego 格式 → 可重試的暫時失敗（絕不當永久失敗）", () => {
    for (const [status, body] of [[200, '{"error":"unauthorized"}'], [404, '{"error":"path_not_allowed"}'], [502, "<html>bad gateway</html>"], [200, '{"code":"abc"}']] as const) {
      const r = parseAmegoResponse(status, body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.retryable).toBe(true);
    }
    const ok = parseAmegoResponse(200, '{"code":0,"msg":"","invoice_number":"AB00000001"}');
    expect(ok.ok).toBe(true);
  });

  it("經中繼：帶中繼密鑰、簽章用送出的同一份 data；非 Amego 回應 → 發票標「可重試」", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-relay");
    await markOrderPaid(s.ctx, { site: "inv-relay", orderNo: s.order.order_no, confirm: true });
    const seen: { url: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
    const amego = createAmegoProvider({ sellerTaxId: "53912857", appKey: "test-app-key-xxx", relayUrl: "https://relay.example.invalid", relaySecret: "relay-secret-xxx" }, async (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: new URLSearchParams(String(init.body)) });
      return new Response('{"error":"path_not_allowed"}', { status: 404 });
    });
    restore = setInvoiceProviderFactoryForTests(async () => amego);
    const r = await issueInvoice(s.ctx, { site: "inv-relay", orderNo: s.order.order_no, confirm: true });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/可重試/);
    expect(r.attempts).toBeLessThan(5); // cron 會繼續重試
    expect(seen[0]!.url).toBe("https://relay.example.invalid/json/f0401");
    expect(seen[0]!.headers["x-relay-secret"]).toBe("relay-secret-xxx");
    const b = seen[0]!.body;
    expect(b.get("sign")).toBe(amegoSign(b.get("data")!, Number(b.get("time")), "test-app-key-xxx"));
    const data = JSON.parse(b.get("data")!);
    expect(data.OrderId).toBe(s.order.order_no);
    expect(data.CarrierType).toBe("3J0002");
    expect(data.CarrierId1).toBe("/ABC+123");
    expect(data.TotalAmount).toBe(s.order.total);
  });

  it("直連時不送中繼密鑰；永久錯誤（欄位錯）不自動重試", async () => {
    const heads: Record<string, string>[] = [];
    const amego = createAmegoProvider({ sellerTaxId: "53912857", appKey: "k-xxxxxxxx", relayUrl: null, relaySecret: "should-not-leak" }, async (_u, init) => {
      heads.push(init.headers as Record<string, string>);
      return new Response('{"code":3040001,"msg":"欄位錯誤"}', { status: 200 });
    });
    const r = await amego.issue({ orderNo: "X-1", total: 100, items: [{ name: "a", qty: 1, unitPrice: 100 }], buyerEmail: "a@example.com", buyerName: "a", request: { type: "member" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryable).toBe(false);
    expect(heads[0]!["x-relay-secret"]).toBeUndefined();
  });
});

describe("作廢 vs 折讓", () => {
  it("同一期（雙月）可作廢；跨期不行", () => {
    const now = new Date("2026-10-19T04:00:00Z");
    expect(canVoidInPeriod("20260901", now)).toBe(true); // 9–10 月同期
    expect(canVoidInPeriod("20261019", now)).toBe(true);
    expect(canVoidInPeriod("20260831", now)).toBe(false); // 7–8 月 → 跨期
    expect(canVoidInPeriod("20251019", now)).toBe(false); // 不同年
    expect(canVoidInPeriod("", now)).toBe(false);
  });

  it("同期 → void；跨期 → 自動改開折讓（可部分金額）", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-void");
    const f = fakeProvider();
    restore = setInvoiceProviderFactoryForTests(async () => f.p);
    await markOrderPaid(s.ctx, { site: "inv-void", orderNo: s.order.order_no, confirm: true });
    await issueInvoice(s.ctx, { site: "inv-void", orderNo: s.order.order_no, confirm: true });
    await expect(voidInvoice(s.ctx, { site: "inv-void", orderNo: s.order.order_no })).rejects.toMatchObject({ code: "confirm_required" });
    const v = await voidInvoice(s.ctx, { site: "inv-void", orderNo: s.order.order_no, confirm: true });
    expect(v.action).toBe("void");
    expect(f.calls.void).toBe(1);
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.invoice_status).toBe("voided");

    // 第二張：發票日期改成上一期 → 折讓
    const s2 = await paidOrderShop(store, "inv-allow");
    await markOrderPaid(s2.ctx, { site: "inv-allow", orderNo: s2.order.order_no, confirm: true });
    await issueInvoice(s2.ctx, { site: "inv-allow", orderNo: s2.order.order_no, confirm: true });
    const inv = (await store.getInvoiceByOrder(s2.tenant.id, s2.order.id))!;
    await store.updateInvoice(s2.tenant.id, inv.id, ["issued"], { invoice_date: "20250101" });
    expect((await getInvoice(s2.ctx, { site: "inv-allow", orderNo: s2.order.order_no })).canVoid).toBe(false);
    await expect(voidInvoice(s2.ctx, { site: "inv-allow", orderNo: s2.order.order_no, confirm: true, allowanceAmount: 999999 })).rejects.toMatchObject({ code: "invalid" });
    const a = await voidInvoice(s2.ctx, { site: "inv-allow", orderNo: s2.order.order_no, confirm: true, allowanceAmount: 100 });
    expect(a.action).toBe("allowance");
    expect(a.allowanceAmount).toBe(100);
    expect(f.calls.allowance).toBe(1);
  });

  it("取消已開立發票的訂單 → 提示 void_invoice", async () => {
    const store = newStore();
    const s = await paidOrderShop(store, "inv-cancel");
    restore = setInvoiceProviderFactoryForTests(async () => fakeProvider().p);
    await markOrderPaid(s.ctx, { site: "inv-cancel", orderNo: s.order.order_no, confirm: true });
    await issueInvoice(s.ctx, { site: "inv-cancel", orderNo: s.order.order_no, confirm: true });
    const c = await cancelOrder(s.ctx, { site: "inv-cancel", orderNo: s.order.order_no, confirm: true });
    expect(c.invoiceActionRequired).toBe(true);
    expect(c.note).toMatch(/void_invoice/);
  });
});

describe("憑證只能平台後台輸入", () => {
  it("token actor 不能存憑證；mock 只限測試租戶；狀態查詢不含 App Key", async () => {
    const store = newStore();
    const shop = await makeShop(store, "inv-cred");
    const ctx = ctxFor(store);
    await enableModule(ctx, { site: "inv-cred", moduleId: "invoice" });
    const tok: Actor = { kind: "token", label: "t", tenantId: shop.tenant.id, scopes: ["invoices:write", "orders:read"] };
    await expect(saveInvoiceAccount(ctxFor(store, tok), { site: "inv-cred", provider: "amego", sellerTaxId: "53912857", appKey: "secret-app-key-123" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveInvoiceAccount(ctx, { site: "inv-cred", provider: "mock", sellerTaxId: "53912857", appKey: "" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveInvoiceAccount(ctx, { site: "inv-cred", provider: "amego", sellerTaxId: "12345678", appKey: "secret-app-key-123" })).rejects.toThrow(/統編/);
    await saveInvoiceAccount(ctx, { site: "inv-cred", provider: "amego", sellerTaxId: "53912857", appKey: "secret-app-key-123" });
    const st = await getInvoiceSetupStatus(ctxFor(store, tok), {});
    expect(JSON.stringify(st)).not.toContain("secret-app-key-123");
    expect(st.invoiceModuleStatus).toBe("pending_setup");
    expect(JSON.stringify(await store.getInvoiceAccount(shop.tenant.id))).not.toContain("secret-app-key-123");
    await configureModule(ctx, { site: "inv-cred", moduleId: "invoice", config: { issueMode: "auto_on_paid" } });
  });
});
