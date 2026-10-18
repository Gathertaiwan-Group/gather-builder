/**
 * directory（人員名錄，記憶體 Store）：上架要 publish＋confirm、草稿不公開、聯絡方式預設不公開、分類、搜尋、租戶隔離、scope。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { publishSite } from "@/lib/services/publish";
import { createPerson, listPeople, publicPeople, updatePerson } from "@/lib/services/directory";
import { searchSite } from "@/lib/services/search";
import { loadSite } from "@/lib/site-loader";
import { validateSectionProps } from "@/modules/registry";
import type { Actor } from "@/lib/tokens";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

describe("directory", () => {
  it("草稿不公開；上架需 confirm；聯絡方式預設不公開、showContact 才顯示；分類；搜尋得到已公開的人", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "assoc", name: "花藝協會", modules: ["sections-basic", "directory", "search"] });
    await publishSite(ctx, { site: "assoc", confirm: true });
    await expect(createPerson(ctx, { site: "assoc", slug: "wang", name: "王理事長", status: "published" })).rejects.toMatchObject({ code: "confirm_required" });
    await createPerson(ctx, { site: "assoc", slug: "wang", name: "王理事長", title: "理事長", category: "理監事", email: "wang@example.com", phone: "0912345678", status: "published", confirm: true });
    await createPerson(ctx, { site: "assoc", slug: "lin", name: "林講師", category: "講師", email: "lin@example.com", showContact: true, status: "published", confirm: true });
    await createPerson(ctx, { site: "assoc", slug: "hidden", name: "未上架的人", category: "講師" });
    const tenant = (await store.getTenantBySlug("assoc"))!;
    const pub = await publicPeople(store, tenant);
    expect(pub.map((p) => p.slug).sort()).toEqual(["lin", "wang"]);
    expect(pub.find((p) => p.slug === "wang")).toMatchObject({ email: null, phone: null });
    expect(pub.find((p) => p.slug === "lin")).toMatchObject({ email: "lin@example.com" });
    expect((await publicPeople(store, tenant, "講師")).map((p) => p.slug)).toEqual(["lin"]);
    expect((await listPeople(ctx, { site: "assoc" })).categories.sort()).toEqual(["理監事", "講師"]);
    const site = (await loadSite("assoc", null, store, { lang: null }))!;
    expect((await searchSite(store, site, "理事長")).results.map((r) => r.href)).toEqual(["/people/wang"]);
    expect((await searchSite(store, site, "未上架")).results).toEqual([]);
    // 修改已公開的人需要 confirm
    await expect(updatePerson(ctx, { site: "assoc", slug: "wang", patch: { title: "名譽理事長" } })).rejects.toMatchObject({ code: "confirm_required" });
    // 沒有 publish scope 只能操作草稿
    const writer: Actor = { kind: "token", tokenId: "t", tenantId: tenant.id, scopes: ["content:write", "site:read"], label: "w" };
    await expect(createPerson(ctxFor(store, writer), { slug: "x1", name: "X", status: "published", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createPerson(ctxFor(store, writer), { slug: "x1", name: "X" })).resolves.toMatchObject({ status: "draft" });
  });

  it("people_grid props 驗證（strict）", () => {
    expect(validateSectionProps("people_grid", { heading: "師資", limit: 8 }).ok).toBe(true);
    expect(validateSectionProps("people_grid", { evil: "<script>" }).ok).toBe(false);
  });
});
