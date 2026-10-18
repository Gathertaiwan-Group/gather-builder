/**
 * 整合測試（npm run test:db）：第三批模組在真 DB 上的原子性／唯一約束。
 * 建 is_test 租戶，跑完刪除（cascade）並清掉限流列。🔴 不呼叫任何外部發票／物流／寄信 API（用假供應商）。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import { createCoupon } from "@/lib/services/coupons";
import { autoIssueOnPaid, saveInvoiceAccount, setInvoiceProviderFactoryForTests, verifyInvoiceAccount } from "@/lib/services/invoices";
import { createMockProvider } from "@/lib/invoice/mock";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itmod-${ts}`;
const contact = { name: "整合測試", email: "itest@example.com", phone: "0912345678" };
const shipping = { name: "整合測試", phone: "0912345678", address: "測試地址" };

describe.skipIf(!enabled)("第三批模組 Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    const db = createServiceClient();
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試商店", async () => {
    await createSite(ctx, { slug, name: slug, modules: ["shop"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, shippingFee: 0, orderPrefix: "IM", maxQtyPerItem: 50 } });
    await enableModule(ctx, { site: slug, moduleId: "invoice", config: { issueMode: "auto_on_paid" } });
    await enableModule(ctx, { site: slug, moduleId: "coupons" });
    await publishSite(ctx, { site: slug, confirm: true });
  });

  it("發票：同一訂單併發觸發自動開立 → DB 只有一列、供應商只被呼叫一次", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    await saveInvoiceAccount(ctx, { site: slug, provider: "mock", sellerTaxId: "53912857", appKey: "" });
    await verifyInvoiceAccount(ctx, { site: slug });
    const p = await createProduct(ctx, { site: slug, slug: "inv", name: "發票商品", price: 300, status: "published", confirm: true });
    const { order } = await placeOrder({ store, baseUrl: "http://itest" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    let issued = 0;
    const mock = createMockProvider();
    const restore = setInvoiceProviderFactoryForTests(async () => ({
      ...mock,
      issue: async (i) => {
        issued++;
        await new Promise((r) => setTimeout(r, 200));
        return mock.issue(i);
      },
    }));
    try {
      // ensureInvoice 在真 DB 上併發：on conflict (order_id) do nothing
      const rows = await Promise.all(Array.from({ length: 6 }, () => store.ensureInvoice({ tenant_id: t.id, order_id: order.id, provider: "mock", amount: order.total })));
      expect(rows.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(rows.map((r) => r.row.id)).size).toBe(1);
      await markOrderPaid(ctx, { site: slug, orderNo: order.order_no, confirm: true });
      const paid = (await store.getOrderById(t.id, order.id))!;
      await Promise.all(Array.from({ length: 5 }, () => autoIssueOnPaid(store, t, paid)));
    } finally {
      restore();
    }
    expect(issued).toBe(1);
    const db = createServiceClient();
    const all = await db.from("builder_invoices").select("id, status, invoice_no").eq("order_id", order.id);
    expect(all.data).toHaveLength(1);
    expect(all.data![0]!.status).toBe("issued");
    expect((await store.getOrderById(t.id, order.id))!.invoice_status).toBe("issued");
    // 直接插第二列 → unique 違反
    const dup = await db.from("builder_invoices").insert({ tenant_id: t.id, order_id: order.id, provider: "mock", amount: 1 });
    expect(dup.error?.code).toBe("23505");
  });

  it("物流：選店暫存併發消耗只成功一次、binding 不符拿不到；同一訂單只能有一張有效出貨單", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const sel = await store.insertCvsSelection({ tenant_id: t.id, trade_no_hash: `h-${ts}`, binding_hash: "bind-ok", sub_type: "UNIMARTC2C", method_id: "seven", expires_at: new Date(Date.now() + 600_000).toISOString() });
    const nowIso = new Date().toISOString();
    expect(await store.consumeCvsSelection(t.id, sel.id, "bind-ok", nowIso)).toBeNull(); // 還沒選門市
    expect(await store.setCvsSelectionStore(`h-${ts}`, "FAMIC2C", { id: "1", name: "x", address: "y", outside: false }, nowIso)).toBeNull(); // 子類型不符
    expect(await store.setCvsSelectionStore(`h-${ts}`, "UNIMARTC2C", { id: "131386", name: "門市", address: "地址", outside: false }, nowIso)).not.toBeNull();
    expect(await store.consumeCvsSelection(t.id, sel.id, "bind-wrong", nowIso)).toBeNull();
    const both = await Promise.all(Array.from({ length: 4 }, () => store.consumeCvsSelection(t.id, sel.id, "bind-ok", new Date().toISOString())));
    expect(both.filter(Boolean)).toHaveLength(1);

    const p = await createProduct(ctx, { site: slug, slug: "ship", name: "出貨", price: 100, status: "published", confirm: true });
    const { order } = await placeOrder({ store, baseUrl: "http://itest" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } });
    const base = { tenant_id: t.id, order_id: order.id, method_id: "m", method_type: "manual" as const, provider: "manual" as const, sub_type: null, logistics_id: null, store: null, tracking_no: null, validation_no: null, stage: false, raw: null };
    const results = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => store.insertShipment({ ...base, merchant_trade_no: `T${ts}${i}`, status: "created" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const active = (await store.getActiveShipmentByOrder(t.id, order.id))!;
    await store.updateShipment(t.id, active.id, { status: "failed" });
    // 失敗的不佔名額，可以重建
    await expect(store.insertShipment({ ...base, merchant_trade_no: `T${ts}x`, status: "created" })).resolves.toBeTruthy();
  });

  it("優惠券：真 DB 併發下單不超用（總次數＋每人次數）、取消回補冪等", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const p = await createProduct(ctx, { site: slug, slug: "cp", name: "券商品", price: 500, status: "published", confirm: true });
    await createCoupon(ctx, { site: slug, code: `IT${ts}`.toUpperCase().slice(0, 32), kind: "fixed", value: 100, maxUses: 3 });
    const code = `IT${ts}`.toUpperCase().slice(0, 32);
    const run = (email: string) => placeOrder({ store, baseUrl: "http://itest" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact: { ...contact, email }, shipping, paymentMethod: "offline", couponCode: code } });
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => run(`race${i}@example.com`)));
    const ok = r.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof run>>>[];
    expect(ok).toHaveLength(3);
    for (const f of r.filter((x) => x.status === "rejected")) expect(String((f as PromiseRejectedResult).reason.message)).toMatch(/優惠券已用完|折扣碼無法使用/);
    const c = (await store.getCouponByCode(t.id, code))!;
    expect(c.used_count).toBe(3);
    expect(ok[0]!.value.order.discount_total).toBe(100);
    expect(ok[0]!.value.order.total).toBe(400);
    // 取消一張 → 回補；重複呼叫回補函式不會多補
    await cancelOrder(ctx, { site: slug, orderId: ok[0]!.value.order.id, confirm: true });
    expect(await store.releaseCoupon(t.id, ok[0]!.value.order.id)).toBe(false);
    expect((await store.getCouponByCode(t.id, code))!.used_count).toBe(2);

    // 每人一次：同一個 email 併發 4 張只成功 1 張
    const code2 = `PU${ts}`.toUpperCase().slice(0, 32);
    await createCoupon(ctx, { site: slug, code: code2, kind: "fixed", value: 10, perUserLimit: 1 });
    const same = await Promise.allSettled(Array.from({ length: 4 }, () => placeOrder({ store, baseUrl: "http://itest" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact: { ...contact, email: "same-user@example.com" }, shipping, paymentMethod: "offline", couponCode: code2 } })));
    expect(same.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await store.getCouponUserCount((await store.getCouponByCode(t.id, code2))!.id, "email:same-user@example.com")).toBe(1);
  });
});
