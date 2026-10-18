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
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
export const slug = `itct-${ts}`;

describe.skipIf(!enabled)("第六批 Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試網站（is_test）", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["sections-basic", "blog", "search", "courses", "shop"], test: true });
    await enableModule(ctx, { site: slug, moduleId: "i18n", config: { languages: ["en"] } });
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
});
