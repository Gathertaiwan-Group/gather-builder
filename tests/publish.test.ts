import { describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { addSection, createSite, getPage, updateSection } from "@/lib/services/sites";
import { listRevisions, previewChanges, publishSite, rollback } from "@/lib/services/publish";
import { ServiceError } from "@/lib/services/context";

describe("草稿 → 發布 → 還原", () => {
  it("版本號遞增、內容快照正確、還原後草稿同步", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    const site = await createSite(ctx, { slug: "demo-shop", name: "示範店", modules: ["sections-basic"] });
    const { sectionId } = await addSection(ctx, { site: site.slug, path: "/", type: "hero", props: { heading: "第一版標題" } });

    const pv = await previewChanges(ctx, { site: site.slug });
    expect(pv.publishedRevision).toBeNull();
    expect(pv.previewUrl).toContain("?preview=");

    await expect(publishSite(ctx, { site: site.slug })).rejects.toMatchObject({ code: "confirm_required" });
    const v1 = await publishSite(ctx, { site: site.slug, confirm: true, note: "first" });
    expect(v1.revision).toBe(1);

    await expect(publishSite(ctx, { site: site.slug, confirm: true })).rejects.toMatchObject({ code: "conflict" });

    await updateSection(ctx, { site: site.slug, path: "/", sectionId, props: { heading: "第二版標題" } });
    const pv2 = await previewChanges(ctx, { site: site.slug });
    expect(pv2.changes.join()).toMatch(/heading/);
    const v2 = await publishSite(ctx, { site: site.slug, confirm: true });
    expect(v2.revision).toBe(2);

    const t = await store.getTenantBySlug(site.slug);
    const cur = await store.getRevision(t!.published_revision_id!);
    expect(cur!.number).toBe(2);
    expect(JSON.stringify(cur!.content)).toContain("第二版標題");

    await expect(rollback(ctx, { site: site.slug, number: 1 })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(rollback(ctx, { site: site.slug, number: 9, confirm: true })).rejects.toMatchObject({ code: "not_found" });
    const rb = await rollback(ctx, { site: site.slug, number: 1, confirm: true });
    expect(rb.publishedRevision).toBe(1);

    const t2 = await store.getTenantBySlug(site.slug);
    const pub = await store.getRevision(t2!.published_revision_id!);
    expect(pub!.number).toBe(1);
    expect(JSON.stringify(pub!.content)).toContain("第一版標題");
    const page = await getPage(ctx, { site: site.slug, path: "/" });
    expect(page.sections.find((s) => s.id === sectionId)!.props.heading).toBe("第一版標題");

    const revs = await listRevisions(ctx, { site: site.slug });
    expect(revs.map((r) => [r.number, r.isCurrent])).toEqual([
      [2, false],
      [1, true],
    ]);

    // 還原後再發布 → 第 3 版（版本號不重用）
    await updateSection(ctx, { site: site.slug, path: "/", sectionId, props: { heading: "第三版" } });
    expect((await publishSite(ctx, { site: site.slug, confirm: true })).revision).toBe(3);

    const audit = await store.listAudit(t2!.id, 50);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["site.create", "section.add", "site.publish", "site.rollback"]));
  });

  it("區塊所屬模組未啟用時不能加入", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    const site = await createSite(ctx, { slug: "no-blog", name: "x" });
    const err = await addSection(ctx, { site: site.slug, path: "/", type: "posts_list" }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe("forbidden");
    expect(err.message).toMatch(/enable_module blog/);
  });
});
