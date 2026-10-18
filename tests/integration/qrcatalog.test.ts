/**
 * 整合測試（npm run test:db）：第八批 qr-catalog 在真 DB 上的行為（migration 0036）。
 * - 商品 brand 欄位；QR 短碼同站唯一、同商品一組（併發也只一組）。
 * - 掃描紀錄只有時間／商品／語言／國家（沒有 IP 欄位）、只增不改（42501）；轉換每張訂單×商品一次。
 * - builder_qr_scan_report／builder_brand_sales 聚合正確（銷量只算已付款、非 sandbox）。
 * 建 is_test 租戶，跑完刪除。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { generateQrLabels, recordOrderConversions, recordScan } from "@/lib/services/qrcatalog";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itqr-${ts}`;

describe.skipIf(!enabled)("qr-catalog（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("brand、QR 短碼（併發只一組）、掃描不存 IP 且只增不改、轉換只一次、報表與品牌銷量聚合", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["shop", "i18n", "qr-catalog"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "QR" } });
    await configureModule(ctx, { site: slug, moduleId: "i18n", config: { languages: ["en", "ja"] } });
    await publishSite(ctx, { site: slug, confirm: true });
    const t = (await store.getTenantBySlug(slug))!;
    const p = await createProduct(ctx, { site: slug, slug: "tea", name: "茶", price: 500, brand: "山嵐", status: "published", confirm: true });
    expect(p.brand).toBe("山嵐");
    const gens = await Promise.all([1, 2, 3].map(() => generateQrLabels(ctx, { site: slug, productIds: [p.id], includeSvg: false })));
    expect(new Set(gens.map((g) => g.labels[0]!.code)).size).toBe(1);
    const code = gens[0]!.labels[0]!.code;
    expect((await db.from("builder_qr_codes").select("id").eq("tenant_id", t.id)).data).toHaveLength(1);

    const s1 = await recordScan(store, t, { code, acceptLanguage: "ja", headers: new Headers({ "x-vercel-ip-country": "JP", "x-forwarded-for": "198.51.100.7" }), ipHash: `it-${ts}`, enabledLangs: ["en", "ja"] });
    await recordScan(store, t, { code, acceptLanguage: "en-US", headers: new Headers({}), ipHash: `it-${ts}`, enabledLangs: ["en", "ja"] });
    const row = (await db.from("builder_qr_scans").select("*").eq("id", s1!.scanId!).single()).data!;
    expect(Object.keys(row).sort()).toEqual(["country", "id", "lang", "product_id", "qr_id", "scanned_at", "tenant_id"]);
    expect(row.country).toBe("JP");
    expect(JSON.stringify(row)).not.toContain("198.51.100.7");
    expect((await db.from("builder_qr_scans").update({ country: "US" }).eq("id", row.id)).error?.code).toBe("42501");
    expect((await db.from("builder_qr_scans").delete().eq("id", row.id)).error?.code).toBe("42501");

    const { order } = await placeOrder({ store, baseUrl: "https://itest.example" }, { tenant: t, member: null, data: { items: [{ productId: p.id, qty: 3 }], contact: { name: "測", email: `qr-${ts}@example.com`, phone: "0912345678" }, shipping: { name: "測", phone: "0912345678", address: "台中" }, paymentMethod: "offline" } });
    const conv = await Promise.all([1, 2].map(() => recordOrderConversions(store, t, order, [s1!.scanId!])));
    expect(conv.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await db.from("builder_qr_conversions").delete().eq("tenant_id", t.id)).error?.code).toBe("42501");

    const rep = await store.qrScanReport(t.id, new Date(Date.now() - 86400_000).toISOString());
    // 這個商品沒有日文／英文翻譯 → 自動 fallback 繁中
    expect(rep.find((r) => r.country === "JP" && r.lang === "zh-TW")).toMatchObject({ scans: 1, orders: 1, inquiries: 0 });
    expect(rep.find((r) => r.country === "" && r.lang === "zh-TW")).toMatchObject({ scans: 1, orders: 0 });
    const since = new Date(Date.now() - 86400_000).toISOString();
    expect(await store.brandSales(t.id, [p.id], since)).toEqual([]); // 未付款不算
    await store.transitionOrder(t.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    expect(await store.brandSales(t.id, [p.id], since)).toEqual([{ product_id: p.id, qty: 3, revenue: 1500, orders: 1 }]);
  });
});
