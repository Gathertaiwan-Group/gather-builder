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
import { markOrderPaid } from "@/lib/services/orders";
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
});
