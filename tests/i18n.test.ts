/**
 * i18n（多語＋AI 翻譯，記憶體 Store）：可翻譯欄位與比對鍵、缺翻譯 fallback、AI 翻譯只進草稿（發布才上線）、
 * AI 多回的 key 被丟掉、手動翻譯預設不被覆蓋、每日上限、語言未開啟 → 404、hreflang、模組資料翻譯要 publish_translations。
 * 🔴 不呼叫真的 Gemini（注入假的 translator）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite, addSection, upsertPage } from "@/lib/services/sites";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createPost } from "@/lib/services/posts";
import { listTranslationStatus, localizeRow, pageSourceFields, publishTranslations, setTranslation, translateContent } from "@/lib/services/i18n";
import { applyTranslations, translatableFields } from "@/lib/i18n/translatable";
import { localizePage, sectionTranslation } from "@/lib/i18n/render";
import { loadSite } from "@/lib/site-loader";
import { pageMetadata } from "@/lib/site-meta";
import { sanitizeTranslation, type Translator } from "@/lib/ai/translate";
import { pagePath } from "@/lib/validators";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
});

/** 假 AI：前面加 EN:，並且故意多回一個不存在的 key 與 slug 欄位 */
const fakeAi: Translator = async ({ fields }) => ({ ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, `EN:${v}`])), evilKey: "x", productSlug: "hacked" });
const factory = () => fakeAi;

async function i18nSite(store: Store, slug: string, extra: Record<string, unknown> = {}) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: "茶行", modules: ["sections-basic", "blog"] });
  await enableModule(ctx, { site: slug, moduleId: "i18n", config: { languages: ["en", "ja"], ...extra } });
  const hero = await addSection(ctx, { site: slug, path: "/", type: "hero", props: { heading: "台灣好茶", subheading: "百年茶行", ctaLabel: "逛逛", ctaHref: "/about" } });
  await upsertPage(ctx, { site: slug, path: "/about", title: "關於我們", seo: { description: "我們的故事" } });
  await publishSite(ctx, { site: slug, confirm: true });
  return { ctx, heroId: hero.sectionId as string };
}

describe("可翻譯欄位與比對鍵", () => {
  it("只取文字欄位：slug、href、url、id、productSlug、數字與網址都不送翻譯；套用時也改不到", () => {
    const props = { heading: "精選", productSlug: "oolong", ctaHref: "/shop", image: "https://x/y.png", items: [{ title: "烏龍", body: "清香", id: "a1", url: "https://a" }], count: 3, note: "https://not-text" };
    expect(translatableFields(props)).toEqual({ heading: "精選", "items.0.title": "烏龍", "items.0.body": "清香" });
    const out = applyTranslations(props, { heading: "Featured", productSlug: "hacked", ctaHref: "/evil", "items.0.title": "Oolong", "items.0.id": "zz", "items.9.title": "x" });
    expect(out).toMatchObject({ heading: "Featured", productSlug: "oolong", ctaHref: "/shop", items: [{ title: "Oolong", body: "清香", id: "a1" }] });
    expect(props.heading).toBe("精選");
  });
  it("AI 回傳多出來的 key 一律丟掉", () => {
    expect(sanitizeTranslation({ title: "茶" }, { title: "Tea", productSlug: "x", other: "y" })).toEqual({ title: "Tea" });
  });
  it("語言代碼保留給網址前綴：不能建立 /en、/ja/x 頁面", () => {
    expect(pagePath.safeParse("/en").success).toBe(false);
    expect(pagePath.safeParse("/ja/about").success).toBe(false);
    expect(pagePath.safeParse("/english").success).toBe(true);
  });
});

describe("頁面翻譯：進草稿、發布才上線、缺翻譯 fallback", () => {
  it("AI 翻譯 → 草稿有、已發布沒有（/en 顯示中文）→ 預覽看得到 → publish_site 後 /en 顯示英文；比對鍵不變", async () => {
    const store = newStore();
    const { ctx, heroId } = await i18nSite(store, "tea-i18n");
    const r = await translateContent(ctx, { site: "tea-i18n", lang: "en", target: { type: "page", path: "/" } }, factory);
    const src = pageSourceFields((await store.getDraft((await store.getTenantBySlug("tea-i18n"))!.id))!.content, "/");
    expect(Object.keys(src)).toEqual(expect.arrayContaining(["title", `s.${heroId}.heading`, `s.${heroId}.subheading`, `s.${heroId}.ctaLabel`]));
    expect(Object.keys(src).some((k) => k.endsWith("ctaHref") || k.endsWith("align"))).toBe(false);
    expect(r).toMatchObject({ draft: true, translated: Object.keys(src).length });
    // 已發布的英文版：還沒有翻譯 → fallback 中文
    const pub = (await loadSite("tea-i18n", null, store, { lang: "en" }))!;
    expect(pub.lang).toBe("en");
    expect(sectionTranslation(pub, "/", heroId)).toBeUndefined();
    // 草稿裡有，標記 ai
    const draft = (await store.getDraft((await store.getTenantBySlug("tea-i18n"))!.id))!.content;
    expect(draft.translations?.en?.pages["/"]?.sections[heroId]).toMatchObject({ heading: { t: "EN:台灣好茶", ai: true }, subheading: { t: "EN:百年茶行", ai: true } });
    expect(JSON.stringify(draft.translations)).not.toContain("hacked");
    await publishSite(ctx, { site: "tea-i18n", confirm: true });
    const live = (await loadSite("tea-i18n", null, store, { lang: "en" }))!;
    const tr = sectionTranslation(live, "/", heroId)!;
    const hero = draft.pages[0]!.sections.find((x) => x.id === heroId)!.props;
    expect(applyTranslations(hero, tr)).toMatchObject({ heading: "EN:台灣好茶", subheading: "EN:百年茶行", ctaLabel: "EN:逛逛", ctaHref: "/about" });
    // 沒翻的頁面 fallback 中文
    expect(localizePage(live, { path: "/about", title: "關於我們", seo: {} }).title).toBe("關於我們");
    // 日文沒翻：fallback
    const ja = (await loadSite("tea-i18n", null, store, { lang: "ja" }))!;
    expect(sectionTranslation(ja, "/", heroId)).toBeUndefined();
  });

  it("沒開啟的語言 → loadSite 回 null（404）；預設語言不加前綴", async () => {
    const store = newStore();
    await i18nSite(store, "tea-langs");
    expect(await loadSite("tea-langs", null, store, { lang: "ko" })).toBeNull();
    expect((await loadSite("tea-langs", null, store, { lang: null }))!.lang).toBe("zh-TW");
  });

  it("hreflang：canonical 是目前語言、alternates 含每個語言與 x-default", async () => {
    const store = newStore();
    await i18nSite(store, "tea-href");
    const site = (await loadSite("tea-href", null, store, { lang: "en" }))!;
    const m = pageMetadata(site, { path: "/about", title: "關於我們", seo: {} }, "https://b.test/s/tea-href/about");
    expect(m.alternates?.canonical).toBe("https://b.test/s/tea-href/en/about");
    expect(m.alternates?.languages).toMatchObject({ "zh-Hant-TW": "https://b.test/s/tea-href/about", en: "https://b.test/s/tea-href/en/about", ja: "https://b.test/s/tea-href/ja/about", "x-default": "https://b.test/s/tea-href/about" });
  });

  it("手動翻譯不被 AI 覆蓋（除非 overwrite）；不能翻譯不存在的欄位", async () => {
    const store = newStore();
    const { ctx, heroId } = await i18nSite(store, "tea-manual");
    await setTranslation(ctx, { site: "tea-manual", lang: "en", target: { type: "page", path: "/" }, fields: { [`s.${heroId}.heading`]: "Fine Taiwan Tea" } });
    await expect(setTranslation(ctx, { site: "tea-manual", lang: "en", target: { type: "page", path: "/" }, fields: { [`s.${heroId}.ctaHref`]: "/evil" } })).rejects.toMatchObject({ code: "invalid" });
    await translateContent(ctx, { site: "tea-manual", lang: "en", target: { type: "page", path: "/" } }, factory);
    let d = (await store.getDraft((await store.getTenantBySlug("tea-manual"))!.id))!.content;
    expect(d.translations?.en?.pages["/"]?.sections[heroId]?.heading).toEqual({ t: "Fine Taiwan Tea" });
    await translateContent(ctx, { site: "tea-manual", lang: "en", target: { type: "page", path: "/" }, overwrite: true }, factory);
    d = (await store.getDraft((await store.getTenantBySlug("tea-manual"))!.id))!.content;
    expect(d.translations?.en?.pages["/"]?.sections[heroId]?.heading).toEqual({ t: "EN:台灣好茶", ai: true });
    const st = await listTranslationStatus(ctx, { site: "tea-manual", lang: "en" });
    expect(st.languages[0]!.pages.find((p) => p.path === "/")).toMatchObject({ fields: Object.keys(pageSourceFields(d, "/")).length, ai: Object.keys(pageSourceFields(d, "/")).length });
  });

  it("每日上限（DB 原子計數）：aiDailyLimit 1 → 第二次被擋、不呼叫 AI", async () => {
    const store = newStore();
    const { ctx } = await i18nSite(store, "tea-limit", { aiDailyLimit: 1 });
    let calls = 0;
    const counting = () => (async (a: Parameters<Translator>[0]) => (calls++, fakeAi(a))) as Translator;
    await translateContent(ctx, { site: "tea-limit", lang: "en", target: { type: "page", path: "/" } }, counting);
    await expect(translateContent(ctx, { site: "tea-limit", lang: "ja", target: { type: "page", path: "/" } }, counting)).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toBe(1);
  });

  it("審查 L5：被每分鐘上限擋下的請求不吃掉每日額度", async () => {
    const store = newStore();
    const { ctx } = await i18nSite(store, "tea-l5", { aiDailyLimit: 50 });
    const tenant = (await store.getTenantBySlug("tea-l5"))!;
    // 先把這一分鐘的額度用完（直接打同一個限流桶）
    for (let i = 0; i < 6; i++) await store.rateHit(`i18n-ai-min:${tenant.id}`, "all", 60, 6);
    await expect(translateContent(ctx, { site: "tea-l5", lang: "en", target: { type: "page", path: "/" } }, factory)).rejects.toThrow(/一分鐘後再試/);
    // 每日桶沒有被扣：第一次 hit 的 count 應為 1
    const { taipeiDay } = await import("@/lib/services/shop");
    expect((await store.rateHit(`i18n-ai-day:${tenant.id}`, taipeiDay(), 86400, 50)).count).toBe(1);
  });

  it("沒開啟的語言不能翻；沒有 AI key 時正式網站不能用 AI 翻譯", async () => {
    const store = newStore();
    const { ctx } = await i18nSite(store, "tea-nokey");
    await expect(translateContent(ctx, { site: "tea-nokey", lang: "ko", target: { type: "page", path: "/" } }, factory)).rejects.toThrow(/尚未開啟/);
    await expect(translateContent(ctx, { site: "tea-nokey", lang: "en", target: { type: "page", path: "/" } }, () => null)).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

describe("模組資料翻譯（文章）", () => {
  it("AI 翻譯文章 → 草稿（已發布網站看不到、預覽看得到）→ publish_translations（confirm）→ 上線；slug 不變", async () => {
    const store = newStore();
    const { ctx } = await i18nSite(store, "tea-post");
    const post = await createPost(ctx, { site: "tea-post", slug: "spring-tea", title: "春茶上市", bodyMd: "今年的春茶很香", status: "published", confirm: true });
    const r = await translateContent(ctx, { site: "tea-post", lang: "en", target: { type: "post", slug: "spring-tea" } }, factory);
    expect(r.translated).toBe(2);
    const site = (await loadSite("tea-post", null, store, { lang: "en" }))!;
    const row = (await store.getPostById(site.tenant.id, post.id))!;
    expect((await localizeRow(store, site, "post", row))!.title).toBe("春茶上市");
    expect((await localizeRow(store, { ...site, mode: "preview" }, "post", row))!.title).toBe("EN:春茶上市");
    await expect(publishTranslations(ctx, { site: "tea-post", lang: "en" })).rejects.toMatchObject({ code: "confirm_required" });
    expect(await publishTranslations(ctx, { site: "tea-post", lang: "en", confirm: true })).toMatchObject({ published: 2 });
    const live = (await localizeRow(store, site, "post", row))!;
    expect(live).toMatchObject({ title: "EN:春茶上市", body_md: "EN:今年的春茶很香", slug: "spring-tea" });
    await expect(setTranslation(ctx, { site: "tea-post", lang: "en", target: { type: "post", slug: "spring-tea" }, fields: { slug: "x" } })).rejects.toMatchObject({ code: "invalid" });
  });

  it("沒開 i18n 的網站：外文網址 404、不能翻譯", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "plain-site", name: "x", modules: ["sections-basic"] });
    await publishSite(ctx, { site: "plain-site", confirm: true }).catch(() => undefined);
    await configureModule(ctx, { site: "plain-site", moduleId: "core", config: { siteDescription: "x" } });
    await publishSite(ctx, { site: "plain-site", confirm: true });
    expect(await loadSite("plain-site", null, store, { lang: "en" })).toBeNull();
    await expect(translateContent(ctx, { site: "plain-site", lang: "en", target: { type: "page", path: "/" } }, factory)).rejects.toMatchObject({ code: "forbidden" });
  });
});
