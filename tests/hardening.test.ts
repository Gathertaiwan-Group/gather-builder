import { describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { authenticateBearer, generateToken, type Actor } from "@/lib/tokens";
import { addSection, createSite, getPage, updateSection } from "@/lib/services/sites";
import { issueToken } from "@/lib/services/tokens";
import { createPortfolioItem, createPost, updatePortfolioItem, updatePost } from "@/lib/services/posts";
import { configureModule, enableModule } from "@/lib/services/modules";
import { previewChanges, publishSite, rollback } from "@/lib/services/publish";
import { submitInquiry, recordLineClick, LINE_CLICK_LIMIT_PER_10MIN } from "@/lib/services/inquiries";
import { mutateDraft } from "@/lib/services/context";
import type { Store } from "@/lib/store/types";
import type { Scope } from "@/lib/scopes";

const platformActor = (scopes: Scope[]): Actor => ({ kind: "token", label: "token:test", tenantId: null, scopes });

describe("#1 token 不能發出比自己大的權限", () => {
  it("只有 platform:sites 的平台 token：issue_site_token 要 publish/inquiries:read 被拒", async () => {
    const store = newStore();
    await createSite(ctxFor(store), { slug: "victim", name: "V" });
    const weak = ctxFor(store, platformActor(["platform:sites"]));
    await expect(issueToken(weak, { site: "victim", name: "x", scopes: ["inquiries:read"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(issueToken(weak, { site: "victim", name: "x", scopes: ["publish", "content:write"] })).rejects.toThrow(/超出自己權限/);
  });
  it("create_site 發出的 token 取呼叫者 scopes 的交集；沒有任何網站 scope 就不發", async () => {
    const store = newStore();
    const r1 = await createSite(ctxFor(store, platformActor(["platform:sites", "site:read"])), { slug: "inter-a", name: "A" });
    expect(r1.tokenScopes).toEqual(["site:read"]);
    const a = await authenticateBearer(store, `Bearer ${r1.token}`);
    expect(a?.scopes).toEqual(["site:read"]);
    const r2 = await createSite(ctxFor(store, platformActor(["platform:sites"])), { slug: "inter-b", name: "B" });
    expect(r2.token).toBeNull();
    expect(r2.tokenScopes).toEqual([]);
  });
  it("具備全部 scope 的平台 token 可以發同等或更小的租戶 token", async () => {
    const store = newStore();
    await createSite(ctxFor(store), { slug: "ok-site", name: "O" });
    const full = ctxFor(store, platformActor(["platform:sites", "site:read", "publish"]));
    const t = await issueToken(full, { site: "ok-site", name: "x", scopes: ["site:read", "publish"] });
    expect(t.scopes).toEqual(["site:read", "publish"]);
  });
});

describe("#2 草稿樂觀鎖", () => {
  it("併發 add_section 不會丟更新", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "race", name: "R" });
    const before = (await getPage(ctx, { site: "race", path: "/" })).sections.length;
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, (_, i) => addSection(ctx, { site: "race", path: "/", type: "rich_text", props: { markdown: `p${i}` } })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const after = (await getPage(ctx, { site: "race", path: "/" })).sections.length;
    expect(after - before).toBe(ok); // 成功幾個就多幾個，沒有被蓋掉的
    expect(ok).toBe(2); // 衝突會自動重試一次
  });
  it("持續衝突時回 conflict，不會默默覆蓋", async () => {
    const base = newStore();
    const ctx0 = ctxFor(base);
    await createSite(ctx0, { slug: "busy", name: "B" });
    const store: Store = { ...base, saveDraft: async () => null };
    const t = (await base.getTenantBySlug("busy"))!;
    await expect(mutateDraft(ctxFor(store), t, () => undefined)).rejects.toMatchObject({ code: "conflict" });
  });
  it("rollback 會遞增草稿版本：還原前讀到的舊草稿無法寫回", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "rb-lock", name: "R" });
    await publishSite(ctx, { site: "rb-lock", confirm: true });
    const t = (await store.getTenantBySlug("rb-lock"))!;
    const stale = (await store.getDraft(t.id))!;
    await rollback(ctx, { site: "rb-lock", number: 1, confirm: true });
    expect(await store.saveDraft(t.id, stale.content, "x", stale.version)).toBeNull();
  });
});

describe("#3 發布的就是預覽／驗證過的那一份", () => {
  it("preview 之後草稿又被改 → 帶 expectedDraftVersion 發布被拒", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "toctou", name: "T" });
    const pv = await previewChanges(ctx, { site: "toctou" });
    await addSection(ctx, { site: "toctou", path: "/", type: "rich_text", props: { markdown: "偷改" } });
    await expect(publishSite(ctx, { site: "toctou", confirm: true, expectedDraftVersion: pv.draftVersion })).rejects.toMatchObject({ code: "conflict" });
    const pv2 = await previewChanges(ctx, { site: "toctou" });
    const r = await publishSite(ctx, { site: "toctou", confirm: true, expectedDraftVersion: pv2.draftVersion });
    expect(r.draftVersion).toBe(pv2.draftVersion);
  });
  it("store.publish 版本不符直接拒絕（RPC 層保護）", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "rpc-v", name: "T" });
    const t = (await store.getTenantBySlug("rpc-v"))!;
    await expect(store.publish(t.id, null, "x", 999)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("#4 會直接上線的寫入要 publish scope + confirm", () => {
  it("文章：published 需 confirm、無 publish scope 被拒、草稿不受限、修改已公開文章需 confirm", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    await createSite(admin, { slug: "live", name: "L", modules: ["blog", "portfolio"] });
    await expect(createPost(admin, { site: "live", slug: "a", title: "A", status: "published" })).rejects.toMatchObject({ code: "confirm_required" });
    const writer = await issueToken(admin, { site: "live", name: "w", scopes: ["content:write", "site:read"] });
    const wctx = ctxFor(store, (await authenticateBearer(store, `Bearer ${writer.token}`))!);
    await expect(createPost(wctx, { slug: "b", title: "B", status: "published", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    const d = await createPost(wctx, { slug: "c", title: "C" });
    expect(d.status).toBe("draft");
    await expect(updatePost(wctx, { slug: "c", patch: { status: "published" }, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    const live = await createPost(admin, { site: "live", slug: "d", title: "D", status: "published", confirm: true });
    expect(live.status).toBe("published");
    await expect(updatePost(admin, { site: "live", slug: "d", patch: { title: "改" } })).rejects.toMatchObject({ code: "confirm_required" });
    await expect(updatePost(wctx, { slug: "d", patch: { title: "改" }, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("作品：預設 draft，公開需 confirm", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    await createSite(admin, { slug: "pf-site", name: "P", modules: ["portfolio"] });
    const it1 = await createPortfolioItem(admin, { site: "pf-site", title: "X", imageUrl: "https://example.com/x.jpg" });
    expect(it1.status).toBe("draft");
    await expect(updatePortfolioItem(admin, { site: "pf-site", itemId: it1.id, patch: { status: "published" } })).rejects.toMatchObject({ code: "confirm_required" });
    const ok = await updatePortfolioItem(admin, { site: "pf-site", itemId: it1.id, patch: { status: "published" }, confirm: true });
    expect(ok.status).toBe("published");
  });
  it("configure_module 只進草稿，發布後才生效", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "cfg", name: "C", modules: ["line"] });
    await publishSite(ctx, { site: "cfg", confirm: true });
    await configureModule(ctx, { site: "cfg", moduleId: "line", config: { lineUrl: "https://lin.ee/abc" } });
    const t = (await store.getTenantBySlug("cfg"))!;
    const live = (await store.getRevision(t.published_revision_id!))!;
    expect(live.content.moduleSettings?.line).toBeUndefined();
    const pv = await previewChanges(ctx, { site: "cfg" });
    expect(pv.changes.join()).toMatch(/模組 line 設定有變/);
    await publishSite(ctx, { site: "cfg", confirm: true });
    const t2 = (await store.getTenantBySlug("cfg"))!;
    expect((await store.getRevision(t2.published_revision_id!))!.content.moduleSettings?.line).toMatchObject({ lineUrl: "https://lin.ee/abc" });
  });
  it("enable_module 帶 config 也只進草稿", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "en-cfg", name: "E" });
    await enableModule(ctx, { site: "en-cfg", moduleId: "contact-form", config: { notifyEmail: "a@example.com" } });
    const page = await previewChanges(ctx, { site: "en-cfg" });
    expect(page.publishedRevision).toBeNull();
    const t = (await store.getTenantBySlug("en-cfg"))!;
    expect((await store.getDraft(t.id))!.content.moduleSettings?.["contact-form"]).toEqual({ notifyEmail: "a@example.com" });
  });
});

describe("跨租戶的 postId／itemId", () => {
  it("A 的 token 拿 B 的 postId、itemId 一律 not_found", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    const a = await createSite(admin, { slug: "x-a", name: "A", modules: ["blog", "portfolio"] });
    await createSite(admin, { slug: "x-b", name: "B", modules: ["blog", "portfolio"] });
    const bPost = await createPost(admin, { site: "x-b", slug: "secret", title: "B 的文章" });
    const bItem = await createPortfolioItem(admin, { site: "x-b", title: "B 的作品", imageUrl: "https://example.com/b.jpg" });
    const actx = ctxFor(store, (await authenticateBearer(store, `Bearer ${a.token}`))!);
    await expect(updatePost(actx, { postId: bPost.id, patch: { title: "改" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(updatePortfolioItem(actx, { itemId: bItem.id, patch: { title: "改" } })).rejects.toMatchObject({ code: "not_found" });
    const bTenant = (await store.getTenantBySlug("x-b"))!;
    expect((await store.getPostById(bTenant.id, bPost.id))!.title).toBe("B 的文章");
  });
});

describe("#5 聯絡表單：honeypot、原子限流、被擋不寄信", () => {
  async function setup() {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "form", name: "F", modules: ["sections-basic", "contact-form"] });
    await configureModule(ctx, { site: "form", moduleId: "contact-form", config: { notifyEmail: "owner@example.com" } });
    await publishSite(ctx, { site: "form", confirm: true });
    const sendMail = vi.fn(async () => undefined);
    return { store, deps: { store, ipSecret: "test-ip-secret", sendMail }, sendMail };
  }
  const data = (i: number, extra: Record<string, unknown> = {}) => ({ name: `n${i}`, email: `u${i}@example.com`, message: "hi", ...extra });

  it("honeypot 有值：回成功但不寫入、不寄信", async () => {
    const { store, deps, sendMail } = await setup();
    const r = await submitInquiry(deps, { slug: "form", ip: "1.1.1.1", data: data(1, { website: "http://spam" }) });
    expect(r.stored).toBe(false);
    const t = (await store.getTenantBySlug("form"))!;
    expect(await store.listInquiries(t.id, { limit: 10 })).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });
  it("併發 10 筆同 IP：只寫入 5 筆、只寄 5 封信，其餘 rate_limited", async () => {
    const { store, deps, sendMail } = await setup();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => submitInquiry(deps, { slug: "form", ip: "2.2.2.2", data: data(i) })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(rs.filter((r) => r.status === "rejected" && (r.reason as { code: string }).code === "rate_limited")).toHaveLength(5);
    const t = (await store.getTenantBySlug("form"))!;
    expect(await store.listInquiries(t.id, { limit: 50 })).toHaveLength(5);
    expect(sendMail).toHaveBeenCalledTimes(5);
    // 別的 IP 不受影響
    expect((await submitInquiry(deps, { slug: "form", ip: "3.3.3.3", data: data(99) })).stored).toBe(true);
  });
  it("通知信收件人讀已發布設定：只改草稿的 notifyEmail 不會生效", async () => {
    const { deps, sendMail } = await setup();
    await configureModule(ctxFor(deps.store), { site: "form", moduleId: "contact-form", config: { notifyEmail: "attacker@example.com" } });
    await submitInquiry(deps, { slug: "form", ip: "4.4.4.4", data: data(1) });
    expect(sendMail).toHaveBeenCalledWith("owner@example.com", expect.any(String), expect.any(String));
  });
});

describe("#9 LINE 點擊限流", () => {
  it(`同 IP 超過 ${LINE_CLICK_LIMIT_PER_10MIN} 次被擋且不寫入`, async () => {
    const store = newStore();
    await createSite(ctxFor(store), { slug: "ln-site", name: "L", modules: ["line"] });
    const deps = { store, ipSecret: "s" };
    for (let i = 0; i < LINE_CLICK_LIMIT_PER_10MIN; i++) await recordLineClick(deps, { slug: "ln-site", ip: "5.5.5.5" });
    await expect(recordLineClick(deps, { slug: "ln-site", ip: "5.5.5.5" })).rejects.toMatchObject({ code: "rate_limited" });
    const t = (await store.getTenantBySlug("ln-site"))!;
    expect(await store.countLineClicks(t.id)).toBe(LINE_CLICK_LIMIT_PER_10MIN);
  });
});

describe("unique 衝突轉友善錯誤", () => {
  it("重複 slug 回 conflict", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "dup", name: "D", modules: ["blog"] });
    await createPost(ctx, { site: "dup", slug: "p", title: "P" });
    await expect(createPost(ctx, { site: "dup", slug: "p", title: "P2" })).rejects.toMatchObject({ code: "conflict" });
  });
  it("sanity：generateToken 前綴", () => {
    expect(generateToken("platform").raw.startsWith("gbp_")).toBe(true);
  });
});

// updateSection 仍能用（迴歸）
describe("迴歸", () => {
  it("update_section 走樂觀鎖後仍正常", async () => {
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "reg", name: "R" });
    const page = await getPage(ctx, { site: "reg", path: "/" });
    await updateSection(ctx, { site: "reg", path: "/", sectionId: page.sections[0]!.id, props: { heading: "新" } });
    expect((await getPage(ctx, { site: "reg", path: "/" })).sections[0]!.props.heading).toBe("新");
  });
});
