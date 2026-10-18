/**
 * search（站內搜尋，記憶體 Store；SQL 版在 tests/integration/content.test.ts）：
 * 租戶隔離、只搜已發布（草稿／未來排程不出現）、付費課程單元內文不被搜出、中文片語、頁面文字、外文翻譯只搜已發布。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite, addSection } from "@/lib/services/sites";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createPost } from "@/lib/services/posts";
import { createProduct } from "@/lib/services/shop";
import { addLesson, createCourse } from "@/lib/services/courses";
import { publishTranslations, setTranslation } from "@/lib/services/i18n";
import { searchSite, snippetOf } from "@/lib/services/search";
import { loadSite } from "@/lib/site-loader";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

async function site(store: Store, slug: string) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: slug, modules: ["sections-basic", "blog", "search", "shop", "courses"] });
  await enableModule(ctx, { site: slug, moduleId: "i18n", config: { languages: ["en"] } });
  await addSection(ctx, { site: slug, path: "/", type: "rich_text", props: { heading: "關於", markdown: "我們專賣阿里山高山烏龍茶" } });
  await publishSite(ctx, { site: slug, confirm: true });
  return ctx;
}
const find = async (store: Store, slug: string, q: string, lang: string | null = null) => (await searchSite(store, (await loadSite(slug, null, store, { lang }))!, q)).results;

describe("search", () => {
  it("租戶隔離：B 站的文章不會出現在 A 站", async () => {
    const store = newStore();
    const a = await site(store, "srch-a");
    const b = await site(store, "srch-b");
    await createPost(a, { site: "srch-a", slug: "a1", title: "冬片茶介紹", bodyMd: "A 的文章", status: "published", confirm: true });
    await createPost(b, { site: "srch-b", slug: "b1", title: "冬片茶限定", bodyMd: "B 的文章", status: "published", confirm: true });
    const r = await find(store, "srch-a", "冬片");
    expect(r.filter((x) => x.kind === "post").map((x) => x.href)).toEqual(["/blog/a1"]);
  });

  it("只搜已發布：草稿文章、未來排程文章、草稿商品都搜不到；中文片語、頁面文字搜得到", async () => {
    const store = newStore();
    const ctx = await site(store, "srch-pub");
    await createPost(ctx, { site: "srch-pub", slug: "draft", title: "秘密新品東方美人", bodyMd: "x" });
    await createPost(ctx, { site: "srch-pub", slug: "future", title: "東方美人預告", bodyMd: "x", status: "published", publishedAt: new Date(Date.now() + 86400_000).toISOString(), confirm: true }).catch(() => undefined);
    await createProduct(ctx, { site: "srch-pub", slug: "dp", name: "東方美人禮盒", price: 900 });
    await createProduct(ctx, { site: "srch-pub", slug: "live", name: "東方美人經典罐", price: 600, status: "published", confirm: true });
    const r = await find(store, "srch-pub", "東方美人");
    expect(r.map((x) => x.href)).toEqual(["/shop/live"]);
    const page = await find(store, "srch-pub", "高山烏龍");
    expect(page[0]).toMatchObject({ kind: "page", href: "/" });
    expect(snippetOf("我們專賣阿里山高山烏龍茶", "高山烏龍")).toContain("高山烏龍");
  });

  it("課程：介紹與單元標題搜得到，付費單元內文搜不到（也不會出現在摘要）", async () => {
    const store = newStore();
    const ctx = await site(store, "srch-course");
    const c = await createCourse(ctx, { site: "srch-course", slug: "tea-101", title: "品茶入門", summary: "從零開始", price: 1200, status: "published", confirm: true });
    await addLesson(ctx, { site: "srch-course", courseId: c.id, slug: "l1", title: "第一課：水溫", bodyMd: "付費秘訣：九十五度沖泡", confirm: true });
    expect((await find(store, "srch-course", "水溫")).map((x) => x.href)).toEqual(["/courses/tea-101"]);
    const paid = await find(store, "srch-course", "九十五度");
    expect(paid).toEqual([]);
    const any = await find(store, "srch-course", "品茶");
    expect(any.every((x) => !x.snippet.includes("九十五度"))).toBe(true);
  });

  it("外文網址：只搜已發布的翻譯", async () => {
    const store = newStore();
    const ctx = await site(store, "srch-en");
    const p = await createPost(ctx, { site: "srch-en", slug: "oolong", title: "烏龍茶", bodyMd: "內容", status: "published", confirm: true });
    await setTranslation(ctx, { site: "srch-en", lang: "en", target: { type: "post", id: p.id }, fields: { title: "Oolong Guide" } });
    expect((await find(store, "srch-en", "oolong guide", "en")).filter((x) => x.kind === "post")).toEqual([]);
    await publishTranslations(ctx, { site: "srch-en", lang: "en", confirm: true });
    const r = (await find(store, "srch-en", "oolong guide", "en")).filter((x) => x.kind === "post");
    expect(r).toMatchObject([{ title: "Oolong Guide", href: "/blog/oolong" }]);
  });
});
