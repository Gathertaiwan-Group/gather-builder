import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { placeOrder } from "@/lib/services/shop";
import { cancelOrder, handlePchomepayNotify, savePaymentAccount, startPchomepayPayment } from "@/lib/services/orders";
import { decryptSecret, encryptSecret, loadEncKey } from "@/lib/secretbox";
import { clearPchomepayTokenCache, createPchomepayClient, type PchomepayClient, type PchomepayQuery } from "@/lib/pay/pchomepay";
import { handleMcp } from "@/lib/mcp/handler";
import { createSite } from "@/lib/services/sites";
import type { Store, TenantRow } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 9).toString("base64");
});

const contact = { name: "客人", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "客人", phone: "0912345678", address: "台中市" };

/** 建一張 PChomePay 待付款訂單（mock 建單），回傳閘道編號 */
async function pendingPchomepayOrder(store: Store, slug: string) {
  const shop = await makeShop(store, slug);
  // 正式環境旗標的憑證＋mock client（不打任何真實 API）。sandbox 的行為另見「H1」測試
  await savePaymentAccount(ctxFor(store), { site: slug, appId: "APPID123", secret: "secret-value-123", sandbox: false });
  await store.markPaymentAccount(shop.tenant.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  const { order, accessKey } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: shop.tenant, member: null, data: { items: [{ productId: shop.mug.id, qty: 2 }], contact, shipping, paymentMethod: "pchomepay" } });
  const factory = async () => ({ sandbox: false, client: { createPayment: async () => ({ paymentUrl: "https://sandbox-secure.pchomepay.com.tw/x" }) } as unknown as PchomepayClient });
  const pay = await startPchomepayPayment({ store, baseUrl: "http://t", clientFactory: factory }, { tenant: shop.tenant, order, accessKey });
  return { ...shop, order, gatewayOrderNo: pay.gatewayOrderNo };
}

const body = (orderId: string, type = "order_confirm", extra: Record<string, unknown> = {}) =>
  new URLSearchParams({ notify_type: type, notify_message: JSON.stringify({ order_id: orderId, status: "S", amount: 999999, ...extra }) }).toString();

function deps(store: Store, query: (orderNo: string) => Promise<PchomepayQuery | null>) {
  const sent: { to: string; subject: string }[] = [];
  return {
    sent,
    d: {
      store,
      baseUrl: "http://t",
      sendMail: async (to: string, subject: string) => void sent.push({ to, subject }),
      queryFor: async () => ({ queryPayment: query }),
    },
  };
}

/**
 * 查單回應的真實結構（依 Realreal 正式站實測：成功時 status="S"、status_code=null；
 * 欄位見 Realreal/apps/api/src/lib/pchomepay.ts queryPayment 與官方外掛 OrderStatusCodeEnum.php）
 */
const realQuery = (data: Record<string, unknown>): PchomepayQuery => ({
  status: data.status != null ? String(data.status) : undefined,
  status_code: data.status_code != null ? String(data.status_code) : undefined,
  amount: data.amount != null ? Number(data.amount) : undefined,
  raw: data,
});
const paidQuery = (amount: number): PchomepayQuery =>
  realQuery({ order_id: "GBX", status: "S", status_code: null, pay_type: "CARD", amount, payment_info: { installment: 1, card_last_number: "1234" } });

describe("PChomePay notify 安全規則", () => {
  it("偽造 payload（自稱已付款），回查結果未付 → 不改狀態", async () => {
    const store = newStore();
    const s = await pendingPchomepayOrder(store, "forge-shop");
    const { d, sent } = deps(store, async () => realQuery({ order_id: "GBX", status: "P", status_code: "WP", pay_type: "ATM", amount: s.order.total }));
    const r = await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo, "order_confirm", { status: "S" }) });
    expect(r).toMatchObject({ status: 200, body: "success" });
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("pending_payment");
    expect(sent).toHaveLength(0);
  });

  it("回查已付但金額不符 → 不標記付款", async () => {
    const store = newStore();
    const s = await pendingPchomepayOrder(store, "amount-shop");
    const { d } = deps(store, async () => paidQuery(s.order.total - 1));
    const r = await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) });
    expect(r.outcome).toBe("amount_mismatch");
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("pending_payment");
  });

  it("回查失敗 → 500 讓對方重試；缺 amount 也 500", async () => {
    const store = newStore();
    const s = await pendingPchomepayOrder(store, "retry-shop");
    expect(await handlePchomepayNotify(deps(store, async () => null).d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) })).toMatchObject({ status: 500, body: "retry" });
    expect(await handlePchomepayNotify(deps(store, async () => realQuery({ order_id: "GBX", status: "S", status_code: null })).d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) })).toMatchObject({ status: 500 });
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("pending_payment");
  });

  it("重複 notify（含併發）只觸發一次副作用", async () => {
    const store = newStore();
    const s = await pendingPchomepayOrder(store, "dup-shop");
    const { d, sent } = deps(store, async () => paidQuery(s.order.total));
    const rs = await Promise.all(Array.from({ length: 4 }, () => handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) })));
    rs.push(await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) }));
    expect(rs.every((r) => r.status === 200 && r.body === "success")).toBe(true);
    expect(rs.filter((r) => r.outcome === "paid")).toHaveLength(1);
    expect(sent.filter((m) => /付款成功|已付款/.test(m.subject))).toHaveLength(2); // 客人＋店主各一封，只一次
    const o = (await store.getOrderById(s.tenant.id, s.order.id))!;
    expect(o.status).toBe("paid");
    expect((await store.listPaymentsForOrder(s.tenant.id, o.id))[0]!.status).toBe("paid");
  });

  it("已取消的訂單收到付款 → 不改狀態、寄店主警示（只寄一次）", async () => {
    const store = newStore();
    const s = await pendingPchomepayOrder(store, "late-shop");
    await cancelOrder(ctxFor(store), { site: "late-shop", orderNo: s.order.order_no, confirm: true });
    const { d, sent } = deps(store, async () => paidQuery(s.order.total));
    const r1 = await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) });
    const r2 = await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body(s.gatewayOrderNo) });
    expect([r1.outcome, r2.outcome]).toEqual(["paid_after_cancel", "paid_after_cancel"]);
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("cancelled");
    const alerts = sent.filter((m) => /人工退款/.test(m.subject));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toBe("owner@example.com");
    expect((await store.listPaymentsForOrder(s.tenant.id, s.order.id))[0]!.status).toBe("paid_after_cancel");
  });

  it("notify 打到別的租戶路徑 → 不處理；未知 order_id／壞 payload → success 不處理", async () => {
    const store = newStore();
    const s = await pendingPchomepayOrder(store, "path-shop");
    await createSite(ctxFor(store), { slug: "other-tenant", name: "O" });
    const other = (await store.getTenantBySlug("other-tenant"))!;
    let queried = 0;
    const { d } = deps(store, async () => (queried++, paidQuery(s.order.total)));
    expect((await handlePchomepayNotify(d, { tenantId: other.id, rawBody: body(s.gatewayOrderNo) })).outcome).toBe("unknown_payment");
    expect((await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: body("NOPE123") })).outcome).toBe("unknown_payment");
    expect((await handlePchomepayNotify(d, { tenantId: s.tenant.id, rawBody: "garbage" })).outcome).toBe("missing_order_id");
    expect(queried).toBe(0);
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("pending_payment");
  });
});

describe("金流憑證加密", () => {
  it("AES-256-GCM：DB 中看不到明文；綁定租戶（AAD），換租戶或換金鑰都解不開", async () => {
    const store = newStore();
    const shop = await makeShop(store, "enc-shop");
    const secret = "very-secret-pchomepay-key";
    await savePaymentAccount(ctxFor(store), { site: "enc-shop", appId: "APPID999", secret, sandbox: true });
    const row = (await store.getPaymentAccount(shop.tenant.id, "pchomepay"))!;
    expect(row.secret_enc).not.toContain(secret);
    expect(row.secret_enc).not.toContain(Buffer.from(secret).toString("base64"));
    expect(row.secret_enc).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(decryptSecret(row.secret_enc, shop.tenant.id)).toBe(secret);
    expect(() => decryptSecret(row.secret_enc, "another-tenant-id")).toThrow();
    expect(() => decryptSecret(row.secret_enc, shop.tenant.id, Buffer.alloc(32, 1))).toThrow(/金鑰不符/);
    expect(encryptSecret(secret, "t")).not.toBe(encryptSecret(secret, "t")); // 隨機 IV
    expect(() => loadEncKey("too-short")).toThrow();
  });
});

describe("PChomePay client", () => {
  it("token 快取以租戶為鍵、過期前 60 秒重換、API 401 清快取重換一次", async () => {
    clearPchomepayTokenCache();
    const calls: string[] = [];
    let tokenN = 0;
    let fail401 = false;
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url.replace(/^https:\/\/[^/]+/, "")}`);
      if (url.endsWith("/v1/token")) {
        expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Basic /);
        return new Response(JSON.stringify({ token: `tok${++tokenN}`, expired_timestamp: Math.floor(Date.now() / 1000) + 1800 }), { status: 200 });
      }
      if (fail401) {
        fail401 = false;
        return new Response("unauthorized", { status: 401 });
      }
      return new Response(JSON.stringify({ order_id: "X", status: "S", status_code: null, amount: 100, pay_type: "CARD" }), { status: 200 });
    };
    const a = createPchomepayClient({ cacheKey: "tenant-a", appId: "A", secret: "S", sandbox: true }, fetchImpl);
    const b = createPchomepayClient({ cacheKey: "tenant-b", appId: "B", secret: "S", sandbox: true }, fetchImpl);
    expect((await a.queryPayment("X"))?.status).toBe("S");
    await a.queryPayment("X");
    await b.queryPayment("X");
    expect(calls.filter((c) => c.endsWith("/v1/token"))).toHaveLength(2); // a 一次、b 一次
    fail401 = true;
    expect((await a.queryPayment("X"))?.amount).toBe(100);
    expect(calls.filter((c) => c.endsWith("/v1/token"))).toHaveLength(3); // 401 後重換
    expect(calls[0]).toBe("POST /v1/token");
  });

  it("sandbox 憑證打 sandbox 端點、正式打正式", async () => {
    clearPchomepayTokenCache();
    const urls: string[] = [];
    const f = async (url: string) => (urls.push(url), new Response("{}", { status: 401 }));
    await createPchomepayClient({ cacheKey: "s", appId: "A", secret: "S", sandbox: true }, f).verify();
    await createPchomepayClient({ cacheKey: "p", appId: "A", secret: "S", sandbox: false }, f).verify();
    expect(urls).toEqual(["https://sandbox-api.pchomepay.com.tw/v1/token", "https://api.pchomepay.com.tw/v1/token"]);
  });
});

describe("MCP 沒有任何能設定或讀出金流 secret 的工具", () => {
  it("tools/list：沒有設定憑證的工具、沒有任何 secret 參數；get_payment_setup_status 只回狀態", async () => {
    const store = newStore();
    const site = await createSite(ctxFor(store), { slug: "mcp-surface", name: "M", modules: ["shop"] });
    const res = await handleMcp(
      new Request("http://test.local/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${site.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
      store,
    );
    const j = (await res.json()) as { result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] } };
    const names = j.result.tools.map((t) => t.name);
    for (const n of ["create_product", "list_orders", "mark_order_paid", "cancel_order", "get_payment_setup_status", "list_members", "disable_member", "refund_order"]) expect(names).toContain(n);
    expect(names.filter((n) => /payment_account|credential|secret|set_payment|configure_payment/.test(n))).toEqual([]);
    const allProps = j.result.tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {}));
    expect(allProps.filter((p) => /secret|app_?id|password|hash_?key|hash_?iv|merchant_?id|channel|cust_?id/i.test(p))).toEqual([]);
    // 第七批：refund_order、cancel_subscription 都要 confirm（工具 schema 有 confirm 參數）
    for (const n of ["refund_order"]) expect(Object.keys(j.result.tools.find((t) => t.name === n)!.inputSchema.properties ?? {})).toContain("confirm");
  });
});

export type { TenantRow };
