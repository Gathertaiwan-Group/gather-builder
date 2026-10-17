/**
 * 整合測試：直接打 Supabase 實作與 builder_publish / builder_rollback / builder_rate_hit。
 * 只在有 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY 時執行（npm run test:db）；
 * 建立 is_test 租戶，跑完整個刪除（cascade）並清掉限流列。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite, addSection } from "@/lib/services/sites";
import { publishSite, previewChanges, rollback } from "@/lib/services/publish";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const slug = `itest-${Date.now().toString(36)}`;
const bucket = `itest:${slug}`;

describe.skipIf(!enabled)("Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    const db = createServiceClient();
    await db.from("builder_tenants").delete().eq("slug", slug);
    await db.from("builder_rate_limits").delete().eq("bucket", bucket);
    const left = await db.from("builder_tenants").select("id").eq("slug", slug);
    expect(left.data).toEqual([]);
  });

  it("草稿樂觀鎖、版本檢查發布、還原遞增草稿版本", async () => {
    await createSite(ctx, { slug, name: "整合測試", test: true });
    const t = (await store.getTenantBySlug(slug))!;
    expect(t.is_test).toBe(true);
    const d1 = (await store.getDraft(t.id))!;
    expect(d1.version).toBe(1);

    // 條件更新：舊版本寫入失敗
    expect(await store.saveDraft(t.id, d1.content, "itest", 1)).toBe(2);
    expect(await store.saveDraft(t.id, d1.content, "itest", 1)).toBeNull();

    const { sectionId } = await addSection(ctx, { site: slug, path: "/", type: "rich_text", props: { markdown: "v1" } });
    const pv = await previewChanges(ctx, { site: slug });
    await expect(store.publish(t.id, null, "itest", pv.draftVersion + 5)).rejects.toMatchObject({ code: "conflict" });
    const p1 = await publishSite(ctx, { site: slug, confirm: true, expectedDraftVersion: pv.draftVersion });
    expect(p1.revision).toBe(1);
    expect(p1.draftVersion).toBe(pv.draftVersion);

    await addSection(ctx, { site: slug, path: "/", type: "rich_text", props: { markdown: "v2" } });
    expect((await publishSite(ctx, { site: slug, confirm: true })).revision).toBe(2);

    const before = (await store.getDraft(t.id))!;
    const rb = await rollback(ctx, { site: slug, number: 1, confirm: true });
    expect(rb.publishedRevision).toBe(1);
    const after = (await store.getDraft(t.id))!;
    expect(after.version).toBe(before.version + 1);
    expect(JSON.stringify(after.content)).toContain(sectionId);
    expect(JSON.stringify(after.content)).not.toContain("v2");
    const t2 = (await store.getTenantBySlug(slug))!;
    expect((await store.getRevision(t2.published_revision_id!))!.number).toBe(1);
    expect((await store.listRevisions(t.id)).map((r) => r.number)).toEqual([2, 1]);
  });

  it("builder_rate_hit 併發原子計數", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.rateHit(bucket, "k", 3600, 5)));
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("重複 slug 轉成 conflict，不外洩約束名", async () => {
    const err = await store.insertTenant({ slug, name: "dup", status: "trial", theme: {}, settings: {}, is_test: true }).catch((e) => e);
    expect(err.code).toBe("conflict");
    expect(err.message).not.toMatch(/builder_tenants_slug_key/);
  });
});
