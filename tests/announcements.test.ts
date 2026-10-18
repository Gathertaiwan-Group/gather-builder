/**
 * announcements（公告，記憶體 Store）：上下架時間、僅會員、置頂排序、必讀確認（只記第一次、未登入不能確認）、
 * 確認名單遮罩、發布要 publish＋confirm。確認紀錄只增不改（42501）在 tests/integration/content.test.ts。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { publishSite } from "@/lib/services/publish";
import { acknowledgeAnnouncement, createAnnouncement, listAnnouncementAcks, listAnnouncements, pendingMustRead, updateAnnouncement, visibleAnnouncements } from "@/lib/services/announcements";
import { validateSectionProps } from "@/modules/registry";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

describe("announcements", () => {
  it("上下架時間、僅會員、置頂；必讀確認只記第一次；確認後不再出現；未登入不能確認", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "union", name: "工會", modules: ["sections-basic", "announcements", "members"] });
    await publishSite(ctx, { site: "union", confirm: true });
    const tenant = (await store.getTenantBySlug("union"))!;
    await expect(createAnnouncement(ctx, { site: "union", title: "x", status: "published" })).rejects.toMatchObject({ code: "confirm_required" });
    const H = 3600_000;
    const pub = await createAnnouncement(ctx, { site: "union", title: "一般公告", status: "published", confirm: true });
    const pin = await createAnnouncement(ctx, { site: "union", title: "置頂公告", pinned: true, status: "published", confirm: true });
    await createAnnouncement(ctx, { site: "union", title: "未來公告", startsAt: new Date(Date.now() + H).toISOString(), status: "published", confirm: true });
    await createAnnouncement(ctx, { site: "union", title: "過期公告", startsAt: new Date(Date.now() - 3 * H).toISOString(), endsAt: new Date(Date.now() - H).toISOString(), status: "published", confirm: true });
    const must = await createAnnouncement(ctx, { site: "union", title: "會員大會必讀", audience: "members", requireAck: true, status: "published", confirm: true });
    await createAnnouncement(ctx, { site: "union", title: "草稿", requireAck: true });
    const guest = await visibleAnnouncements(store, tenant, null);
    expect(guest.map((a) => a.title)).toEqual(["置頂公告", "一般公告"]);
    const m = (await store.insertMember({ tenant_id: tenant.id, email: "worker@example.com", password_hash: "x", name: "張工會", phone: null }))!;
    expect((await visibleAnnouncements(store, tenant, m)).map((a) => a.title)).toContain("會員大會必讀");
    expect((await pendingMustRead(store, tenant, m)).map((a) => a.id)).toEqual([must.id]);
    await expect(acknowledgeAnnouncement(store, { tenant, member: null, announcementId: must.id })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(acknowledgeAnnouncement(store, { tenant, member: m, announcementId: pub.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await acknowledgeAnnouncement(store, { tenant, member: m, announcementId: must.id })).toEqual({ first: true });
    expect(await acknowledgeAnnouncement(store, { tenant, member: m, announcementId: must.id })).toEqual({ first: false });
    expect(await pendingMustRead(store, tenant, m)).toEqual([]);
    const acks = await listAnnouncementAcks(ctx, { site: "union", announcementId: must.id });
    expect(acks).toMatchObject({ total: 1, acks: [{ name: "張＊會", email: "wo＊＊＊@example.com" }] });
    expect((await listAnnouncements(ctx, { site: "union" })).announcements.find((a) => a.id === must.id)).toMatchObject({ acks: 1, live: true });
    // 下架後就不需要確認、也看不到
    await expect(updateAnnouncement(ctx, { site: "union", announcementId: pin.id, patch: { status: "draft" } })).rejects.toMatchObject({ code: "confirm_required" });
    await updateAnnouncement(ctx, { site: "union", announcementId: pin.id, patch: { status: "draft" }, confirm: true });
    expect((await visibleAnnouncements(store, tenant, null)).map((a) => a.title)).toEqual(["一般公告"]);
    await expect(createAnnouncement(ctx, { site: "union", title: "x", startsAt: new Date(Date.now() + 2 * H).toISOString(), endsAt: new Date(Date.now() + H).toISOString() })).rejects.toMatchObject({ code: "invalid" });
  });

  it("區塊 props", () => {
    expect(validateSectionProps("announcements_bar", { limit: 2 }).ok).toBe(true);
    expect(validateSectionProps("announcements_list", { heading: "公告", limit: 5 }).ok).toBe(true);
    expect(validateSectionProps("announcements_bar", { limit: 9 }).ok).toBe(false);
  });
});
