/**
 * 整合測試（npm run test:db）：第六批（i18n／search／directory／downloads／certificates／reviews／announcements）在真 DB 上的行為。
 * 建 is_test 租戶，跑完刪除。🔴 不寄信、不呼叫 Gemini（注入假的 translator）、Storage 只用 builder- 開頭的 bucket。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createPost } from "@/lib/services/posts";
import { localizeRow, publishTranslations, translateContent } from "@/lib/services/i18n";
import { loadSite } from "@/lib/site-loader";
import { searchSite } from "@/lib/services/search";
import { addLesson, createCourse } from "@/lib/services/courses";
import { createPerson } from "@/lib/services/directory";
import { completeDocumentUpload, createDocumentUpload, downloadDocument, uploadDocumentDirect } from "@/lib/services/downloads";
import { DOWNLOADS_BUCKET, supabaseFileStorage } from "@/lib/storage/files";
import { LOOKUP_NOT_FOUND, importCertificates, lookupCertificate } from "@/lib/services/certificates";
import { createReview, productReviewSummary } from "@/lib/services/reviews";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { markOrderPaid } from "@/lib/services/orders";
import { configureModule } from "@/lib/services/modules";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
export const slug = `itct-${ts}`;

describe.skipIf(!enabled)("第六批 Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };

  const uploaded: string[] = [];
  afterAll(async () => {
    if (!enabled) return;
    // 只刪這次測試在 builder-downloads 自己租戶資料夾下建立的物件（Storage API）
    if (uploaded.length) await db.storage.from(DOWNLOADS_BUCKET).remove(uploaded);
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試網站（is_test）", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["sections-basic", "blog", "search", "courses", "shop", "directory", "downloads", "certificates", "reviews"], test: true });
    await enableModule(ctx, { site: slug, moduleId: "i18n", config: { languages: ["en"] } });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "CT" } });
    await publishSite(ctx, { site: slug, confirm: true });
  });

  it("i18n：文章翻譯草稿 → 已發布網站看不到 → publish_translations 後才看得到；slug 不變", async () => {
    const post = await createPost(ctx, { site: slug, slug: "hello", title: "你好", bodyMd: "內容", status: "published", confirm: true });
    const fake = () => async ({ fields }: { fields: Record<string, string> }) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `EN ${v}`]));
    await translateContent(ctx, { site: slug, lang: "en", target: { type: "post", id: post.id } }, fake);
    const site = (await loadSite(slug, null, store, { lang: "en" }))!;
    const row = (await store.getPostById(site.tenant.id, post.id))!;
    expect((await localizeRow(store, site, "post", row))!.title).toBe("你好");
    expect(await publishTranslations(ctx, { site: slug, lang: "en", confirm: true })).toMatchObject({ published: 2 });
    expect(await localizeRow(store, site, "post", row)).toMatchObject({ title: "EN 你好", slug: "hello" });
    // 欄位白名單在 DB 端也擋（slug 不能存）
    const bad = await db.from("builder_translations").insert({ tenant_id: site.tenant.id, entity_type: "post", entity_id: post.id, lang: "en", field: "slug", draft_value: "x" });
    expect(bad.error?.code).toBe("23514");
  });

  it("search（SQL builder_search_content）：只搜已發布、該租戶；課程單元內文不被搜出；中文片語；萬用字元不會變成萬用", async () => {
    await createPost(ctx, { site: slug, slug: "pub-tea", title: "凍頂烏龍上市", bodyMd: "百分之百台灣茶", status: "published", confirm: true });
    await createPost(ctx, { site: slug, slug: "draft-tea", title: "凍頂烏龍草稿", bodyMd: "x" });
    const c = await createCourse(ctx, { site: slug, slug: "brew", title: "沖泡課", price: 500, status: "published", confirm: true });
    await addLesson(ctx, { site: slug, courseId: c.id, slug: "l1", title: "溫杯", bodyMd: "付費內容：獨門手法", confirm: true });
    const site = (await loadSite(slug, null, store, { lang: null }))!;
    const r = await searchSite(store, site, "凍頂烏龍");
    expect(r.results.filter((x) => x.kind === "post").map((x) => x.href)).toEqual(["/blog/pub-tea"]);
    expect((await searchSite(store, site, "獨門手法")).results).toEqual([]);
    expect((await searchSite(store, site, "溫杯")).results.map((x) => x.href)).toEqual(["/courses/brew"]);
    // % 與 _ 是普通字元（strpos），不會變成「全部符合」
    expect((await searchSite(store, site, "%")).results).toEqual([]);
    // 其他租戶看不到
    const other = await store.searchContent("00000000-0000-0000-0000-000000000000", "凍頂", null, 10);
    expect(other).toEqual([]);
  });

  it("directory：SQL 搜尋只找已公開的人員", async () => {
    await createPerson(ctx, { site: slug, slug: "chen", name: "陳醫師", title: "主治醫師", status: "published", confirm: true });
    await createPerson(ctx, { site: slug, slug: "draft-person", name: "陳草稿", title: "主治醫師" });
    const site = (await loadSite(slug, null, store, { lang: null }))!;
    expect((await searchSite(store, site, "主治醫師")).results.map((r) => r.href)).toEqual(["/people/chen"]);
  });

  it("downloads（真 Storage builder-downloads）：簽名上傳 PUT → 確認 → 限會員擋未登入 → 簽名網址可下載、過期後失效", async () => {
    const storage = supabaseFileStorage(db);
    const tenant = (await store.getTenantBySlug(slug))!;
    const up = await createDocumentUpload(ctx, { site: slug, fileName: "測試文件.txt", title: "整合測試文件", visibility: "members" }, storage);
    const put = await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": up.contentType }, body: "hello builder" });
    expect(put.ok).toBe(true);
    const doc = await completeDocumentUpload(ctx, { site: slug, documentId: up.documentId, publish: true, confirm: true }, storage);
    uploaded.push((await store.getDocument(tenant.id, up.documentId))!.file_path!);
    expect(doc).toMatchObject({ status: "published", sizeBytes: 13 });
    await expect(downloadDocument(store, storage, { tenant, documentId: up.documentId, member: null })).rejects.toMatchObject({ code: "unauthorized" });
    const m = (await store.insertMember({ tenant_id: tenant.id, email: `dl-${Date.now()}@example.com`, password_hash: "x", name: "會員", phone: null }))!;
    const r = await downloadDocument(store, storage, { tenant, documentId: up.documentId, member: m });
    const got = await fetch(r.url);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("hello builder");
    expect(got.headers.get("content-disposition") ?? "").toMatch(/attachment/);
    // 過期：直接要一個 1 秒的簽名網址，等 3 秒
    const short = await storage.signedDownloadUrl(doc.id ? (await store.getDocument(tenant.id, up.documentId))!.file_path! : "", 1, "x.txt");
    await new Promise((res) => setTimeout(res, 3000));
    const expired = await fetch(short);
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect((await store.getDocument(tenant.id, up.documentId))!.download_count).toBe(1);
    // 表單直傳
    const d2 = await uploadDocumentDirect(ctx, { site: slug, fileName: "a.txt", bytes: new TextEncoder().encode("x"), title: "直傳" }, storage);
    uploaded.push((await store.getDocument(tenant.id, d2.id))!.file_path!);
    // 匿名 key 讀不到私有 bucket（沒有簽名就不能下載）
    const anon = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/${DOWNLOADS_BUCKET}/${uploaded[0]}`);
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });

  it("certificates：匯入、證號容錯查詢、不回生日、查無同一句話；查詢紀錄只增不改（42501）", async () => {
    const tenant = (await store.getTenantBySlug(slug))!;
    await importCertificates(ctx, { site: slug, csv: "證號,姓名,生日,類別\nTW-2026-0001,吳宗憲,1980-08-08,講師\n", confirm: true });
    const r = await lookupCertificate(store, tenant, { certNo: "tw 2026 0001", ipHash: `it-${ts}` });
    expect(r).toMatchObject({ found: true, results: [{ certNo: "TW-2026-0001", name: "吳＊憲" }] });
    expect(JSON.stringify(r)).not.toContain("1980");
    expect(await lookupCertificate(store, tenant, { name: "吳宗憲", birth: "1980-08-09", ipHash: `it2-${ts}` })).toEqual({ found: false, message: LOOKUP_NOT_FOUND });
    const up = await db.from("builder_cert_lookups").update({ found: true }).eq("tenant_id", tenant.id);
    expect(up.error?.code).toBe("42501");
    const del = await db.from("builder_cert_lookups").delete().eq("tenant_id", tenant.id);
    expect(del.error?.code).toBe("42501");
    expect((await store.listCertLookups(tenant.id, 10)).length).toBe(2);
  });

  it("reviews：同一訂單同一商品併發 5 次只成立 1 則（DB unique）；未審核不公開", async () => {
    const tenant = (await store.getTenantBySlug(slug))!;
    const p = await createProduct(ctx, { site: slug, slug: "teapot", name: "茶壺", price: 800, status: "published", confirm: true });
    const m = (await store.insertMember({ tenant_id: tenant.id, email: `rv-${ts}@example.com`, password_hash: "x", name: "評價者", phone: null }))!;
    const { order } = await placeOrder({ store, baseUrl: "http://itest" }, { tenant, member: m, data: { items: [{ productId: p.id, qty: 1 }], contact: { name: "評價者", email: m.email, phone: "0912345678" }, shipping: { name: "評價者", phone: "0912345678", address: "台中" }, paymentMethod: "offline" } });
    await markOrderPaid(ctx, { site: slug, orderNo: order.order_no, confirm: true });
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => createReview(store, { tenant, member: m, data: { productId: p.id, orderId: order.id, rating: 5 } })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await productReviewSummary(store, tenant, p.id)).count).toBe(0);
  });
});
