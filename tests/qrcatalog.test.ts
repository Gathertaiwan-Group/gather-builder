/**
 * 第八批：qr-catalog（實體門市 QR 多語商品頁）。記憶體 Store。
 * QR 短碼不可預測、QR 圖可被解碼成短連結、落地頁語言選擇與 fallback、掃描紀錄不存 IP、國家碼只來自 geo header（可缺）、
 * 掃碼後訂單／詢價轉換、品牌報表簽章／撤銷／到期且不含個資、租戶隔離。
 */
import { beforeAll, describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule, configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder, updateProduct } from "@/lib/services/shop";
import { setTranslation, publishTranslations } from "@/lib/services/i18n";
import {
  QR_CODE_RE,
  availableLangsFor,
  brandReport,
  countryFromHeaders,
  createBrandReportLink,
  generateQrLabels,
  genQrCode,
  getScanReport,
  labelsUrl,
  pickLang,
  readScanCookie,
  recordOrderConversions,
  recordScan,
  revokeBrandReportLink,
  signScanCookie,
  submitOverseasInquiry,
  verifyLabelsUrl,
} from "@/lib/services/qrcatalog";
import { qrPng } from "@/lib/qr";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

async function qrShop(store: Store, slug: string, opts: { ja?: boolean } = {}) {
  const shop = await makeShop(store, slug);
  await enableModule(shop.ctx, { site: slug, moduleId: "qr-catalog", config: {} });
  await configureModule(shop.ctx, { site: slug, moduleId: "i18n", config: { languages: ["en", "ja"] } });
  await configureModule(shop.ctx, { site: slug, moduleId: "qr-catalog", config: { currencies: [{ code: "JPY", rate: 4.7 }] } });
  await publishSite(shop.ctx, { site: slug, confirm: true });
  await updateProduct(shop.ctx, { site: slug, productId: shop.mug.id, patch: { brand: "山嵐茶行" }, confirm: true });
  if (opts.ja) {
    await setTranslation(shop.ctx, { site: slug, lang: "ja", target: { type: "product", id: shop.mug.id }, fields: { name: "マグカップ" } });
    await publishTranslations(shop.ctx, { site: slug, lang: "ja", confirm: true });
  }
  const labels = await generateQrLabels(shop.ctx, { site: slug, productIds: [shop.mug.id] });
  return { ...shop, code: labels.labels[0]!.code, labels };
}
const h = (o: Record<string, string>) => new Headers(o);

describe("QR 短碼與圖", () => {
  it("短碼 10 字英數、1000 個不重複；同商品重印沿用同一組；QR 圖解碼後就是短連結", async () => {
    const codes = new Set(Array.from({ length: 1000 }, () => genQrCode()));
    expect(codes.size).toBe(1000);
    for (const c of codes) expect(c).toMatch(QR_CODE_RE);
    const store = newStore();
    const s = await qrShop(store, "qr-img");
    expect(s.labels.labels[0]).toMatchObject({ name: "馬克杯", price: 350, brand: "山嵐茶行", url: `http://test.local/s/qr-img/q/${s.code}` });
    expect(s.labels.labels[0]!.svg).toMatch(/^<svg/);
    const again = await generateQrLabels(s.ctx, { site: "qr-img", productIds: [s.mug.id] });
    expect(again.labels[0]!.code).toBe(s.code);
    const png = PNG.sync.read(await qrPng(s.labels.labels[0]!.url, 256));
    expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(s.labels.labels[0]!.url);
  });

  it("A4 標籤頁網址：簽章綁租戶與碼、1 小時到期", async () => {
    const store = newStore();
    const s = await qrShop(store, "qr-labels");
    const u = new URL(labelsUrl("http://x", s.tenant, [s.code]));
    const [c, exp, t] = ["c", "exp", "t"].map((k) => u.searchParams.get(k)!) as [string, string, string];
    expect(verifyLabelsUrl(s.tenant, c, exp, t)).toEqual([s.code]);
    expect(verifyLabelsUrl({ id: "00000000-0000-0000-0000-000000000000" }, c, exp, t)).toBeNull();
    expect(verifyLabelsUrl(s.tenant, `${c},AAAAAAAAAA`, exp, t)).toBeNull();
    expect(verifyLabelsUrl(s.tenant, c, exp, t, Date.now() + 2 * 3600_000)).toBeNull();
  });
});

describe("語言與國家", () => {
  it("pickLang：依 q 值、只選有的語言、zh 系列歸繁中、都沒有回 zh-TW", () => {
    const all = ["zh-TW", "en", "ja"];
    expect(pickLang("ja-JP,ja;q=0.9,en;q=0.8", all)).toBe("ja");
    expect(pickLang("ja-JP,ja;q=0.9,en;q=0.8", ["zh-TW", "en"])).toBe("en");
    expect(pickLang("ja-JP", ["zh-TW"])).toBe("zh-TW");
    expect(pickLang("en;q=0.5,ja;q=0.9", all)).toBe("ja");
    expect(pickLang("zh-HK,zh;q=0.9", all)).toBe("zh-TW");
    expect(pickLang("fr-FR,*;q=0.1", all)).toBe("zh-TW");
    expect(pickLang(null, all)).toBe("zh-TW");
    expect(pickLang("ja;q=0", all)).toBe("zh-TW");
  });

  it("國家碼只認 x-vercel-ip-country 兩碼（可缺）", () => {
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "JP" }))).toBe("JP");
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "us" }))).toBe("US");
    expect(countryFromHeaders(h({}))).toBeNull();
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "XX" }))).toBeNull();
    expect(countryFromHeaders(h({ "x-vercel-ip-country": "JPN" }))).toBeNull();
    expect(countryFromHeaders(h({ "cf-ipcountry": "JP", "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });

  it("有日文翻譯才自動切日文；沒翻譯 fallback（英文也沒有 → 繁中）", async () => {
    const store = newStore();
    const s = await qrShop(store, "qr-lang-no");
    expect(await availableLangsFor(store, s.tenant, ["en", "ja"], s.mug.id)).toEqual(["zh-TW"]);
    const r = await recordScan(store, s.tenant, { code: s.code, acceptLanguage: "ja-JP,ja;q=0.9", headers: h({}), ipHash: "ip1", enabledLangs: ["en", "ja"] });
    expect(r?.lang).toBe("zh-TW");
    const s2 = await qrShop(store, "qr-lang-ja", { ja: true });
    const r2 = await recordScan(store, s2.tenant, { code: s2.code, acceptLanguage: "ja-JP,ja;q=0.9", headers: h({ "x-vercel-ip-country": "JP" }), ipHash: "ip1", enabledLangs: ["en", "ja"] });
    expect(r2?.lang).toBe("ja");
    // 網站沒開日文 → 不切
    expect((await recordScan(store, s2.tenant, { code: s2.code, acceptLanguage: "ja", headers: h({}), ipHash: "ip2", enabledLangs: ["en"] }))?.lang).toBe("zh-TW");
  });
});

describe("掃描紀錄與轉換", () => {
  it("掃描只存時間／商品／語言／國家，不存 IP 與 UA；國家缺省為 null", async () => {
    const store = newStore();
    const s = await qrShop(store, "qr-scan", { ja: true });
    const a = await recordScan(store, s.tenant, { code: s.code, acceptLanguage: "ja", headers: h({ "x-vercel-ip-country": "JP", "x-forwarded-for": "203.0.113.9", "user-agent": "iPhone" }), ipHash: "hash-of-ip", enabledLangs: ["en", "ja"] });
    const b = await recordScan(store, s.tenant, { code: s.code, acceptLanguage: "en", headers: h({}), ipHash: "hash-of-ip", enabledLangs: ["en", "ja"] });
    const rows = await store.listQrScansByIds(s.tenant.id, [a!.scanId!, b!.scanId!]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["country", "id", "lang", "product_id", "qr_id", "scanned_at", "tenant_id"]);
      expect(JSON.stringify(r)).not.toMatch(/203\.0\.113\.9|hash-of-ip|iPhone/);
    }
    expect(rows.map((r) => r.country).sort()).toEqual(["JP", null].sort());
    expect(await recordScan(store, s.tenant, { code: "AAAAAAAAAA", acceptLanguage: null, headers: h({}), ipHash: "x", enabledLangs: [] })).toBeNull();
  });

  it("掃描 cookie 簽章（竄改／別站無效）；掃碼後下單＋海外詢價 → 報表 JP×ja 掃描 1、訂單 1、詢價 1", async () => {
    const store = newStore();
    const s = await qrShop(store, "qr-conv", { ja: true });
    const sc = await recordScan(store, s.tenant, { code: s.code, acceptLanguage: "ja", headers: h({ "x-vercel-ip-country": "JP" }), ipHash: "ip", enabledLangs: ["en", "ja"] });
    const cookie = signScanCookie(s.tenant.id, [sc!.scanId!]);
    expect(readScanCookie(s.tenant.id, cookie)).toEqual([sc!.scanId]);
    expect(readScanCookie(s.tenant.id, cookie.replace(/^\d+/, "99"))).toEqual([]);
    expect(readScanCookie("00000000-0000-0000-0000-000000000000", cookie)).toEqual([]);
    const { order } = await placeOrder({ store, baseUrl: "http://test.local" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact: { name: "Tanaka", email: "t@example.com", phone: "0912345678" }, shipping: { name: "Tanaka", phone: "0912345678", address: "台北" }, paymentMethod: "offline" } });
    expect(await recordOrderConversions(store, s.tenant, order, readScanCookie(s.tenant.id, cookie))).toBe(1);
    expect(await recordOrderConversions(store, s.tenant, order, readScanCookie(s.tenant.id, cookie))).toBe(0); // 冪等
    await submitOverseasInquiry({ store }, { tenant: s.tenant, data: { code: s.code, lang: "ja", name: "山田", email: "y@example.com", country: "jp", address: "東京都千代田区1-1" }, scanIds: [sc!.scanId!], ipHash: "ip" });
    await expect(submitOverseasInquiry({ store }, { tenant: s.tenant, data: { code: s.code, name: "x", email: "bad", country: "JP", address: "東京都千代田区" }, scanIds: [], ipHash: "ip" })).rejects.toMatchObject({ code: "invalid" });
    // 第八批審查 L-5：訂單還沒付款 → 報表不計入訂單轉換
    expect((await getScanReport(s.ctx, { site: "qr-conv" })).rows).toEqual([expect.objectContaining({ productId: s.mug.id, scans: 1, orders: 0, inquiries: 1 })]);
    await store.transitionOrder(s.tenant.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    const rep = await getScanReport(s.ctx, { site: "qr-conv" });
    expect(rep.rows).toEqual([expect.objectContaining({ productId: s.mug.id, country: "JP", lang: "ja", scans: 1, orders: 1, inquiries: 1, conversionRate: 200 })]);
    const inq = await store.listInquiries(s.tenant.id, { limit: 5 });
    expect(inq[0]!.message).toContain("［海外寄送詢價］");
  });
});

describe("品牌報表", () => {
  it("需 confirm；簽章連結看得到自家商品統計、不含個資；撤銷／到期／簽章錯／別站一律看不到", async () => {
    const store = newStore();
    const s = await qrShop(store, "qr-brand");
    await expect(createBrandReportLink(s.ctx, { site: "qr-brand", brand: "山嵐茶行" })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(createBrandReportLink(s.ctx, { site: "qr-brand", brand: "不存在", confirm: true })).rejects.toMatchObject({ code: "not_found" });
    const link = await createBrandReportLink(s.ctx, { site: "qr-brand", brand: "山嵐茶行", expiresInDays: 7, confirm: true });
    const token = decodeURIComponent(link.url.split("/brand-report/")[1]!);
    const { order } = await placeOrder({ store, baseUrl: "http://test.local" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 2 }], contact: { name: "買家甲", email: "buyer@example.com", phone: "0912345678" }, shipping: { name: "買家甲", phone: "0912345678", address: "台北市信義區" }, paymentMethod: "offline" } });
    await store.transitionOrder(s.tenant.id, order.id, "pending_payment", "paid", { paid_at: new Date().toISOString() });
    // 第八批審查 L-4：同品牌但未上架（草稿）的商品不出現在品牌報表
    await createProduct(s.ctx, { site: "qr-brand", slug: "draft-cup", name: "未上架杯", price: 100, brand: "山嵐茶行" });
    const r = (await brandReport(store, s.tenant, token))!;
    expect(r.products.map((p) => p.name)).toEqual(["馬克杯"]); // T 恤不是這個品牌；草稿不列
    expect(r.products[0]).toMatchObject({ soldQty: 2, revenue: 700, paidOrders: 1 });
    expect(JSON.stringify(r)).not.toMatch(/buyer@example\.com|買家甲|0912345678|信義區/);
    expect(await brandReport(store, s.tenant, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    const other = await qrShop(store, "qr-brand-b");
    expect(await brandReport(store, other.tenant, token)).toBeNull();
    await store.revokeBrandReportLink(s.tenant.id, "00000000-0000-0000-0000-000000000000");
    expect((await revokeBrandReportLink(s.ctx, { site: "qr-brand", linkId: link.linkId })).revoked).toBe(true);
    expect(await brandReport(store, s.tenant, token)).toBeNull();
    // 到期
    const l2 = await createBrandReportLink(s.ctx, { site: "qr-brand", brand: "山嵐茶行", expiresInDays: 1, confirm: true });
    const row = (await store.getBrandReportLink(s.tenant.id, l2.linkId))!;
    expect(await brandReport(store, s.tenant, decodeURIComponent(l2.url.split("/brand-report/")[1]!))).not.toBeNull();
    (row as { expires_at: string }).expires_at = new Date(Date.now() - 1000).toISOString();
    const fakeStore = { ...store, getBrandReportLink: async () => row } as Store;
    expect(await brandReport(fakeStore, s.tenant, decodeURIComponent(l2.url.split("/brand-report/")[1]!))).toBeNull();
  });

  it("租戶隔離：別站的商品不能產生 QR、別站的碼查不到", async () => {
    const store = newStore();
    const a = await qrShop(store, "qr-iso-a");
    const b = await qrShop(store, "qr-iso-b");
    await expect(generateQrLabels(a.ctx, { site: "qr-iso-a", productIds: [b.mug.id] })).rejects.toMatchObject({ code: "not_found" });
    expect(await store.getQrCodeByCode(a.tenant.id, b.code)).toBeNull();
    expect(await recordScan(store, a.tenant, { code: b.code, acceptLanguage: null, headers: h({}), ipHash: "x", enabledLangs: [] })).toBeNull();
    void ctxFor;
  });
});
