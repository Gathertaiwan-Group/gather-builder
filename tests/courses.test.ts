/**
 * courses 模組（記憶體 Store）：付款成功（權威回查）才開通、sandbox 付款不開通、重複 notify 只開通一次、取消撤銷、
 * 手動開通／撤銷（confirm）、未開通者拿不到付費影片網址（server 端）、試看、進度、影片白名單、租戶隔離、scope。
 * 🔴 金流一律 mock 回查結果，不打 PChomePay。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { cancelOrder, handlePchomepayNotify, markOrderPaid, savePaymentAccount, startPchomepayPayment, type PayDeps } from "@/lib/services/orders";
import { registerMember } from "@/lib/services/members";
import { addLesson, buyCourse, createCourse, grantCourse, lessonForViewer, listEnrollments, markLessonComplete, revokeCourse, updateCourse, updateLesson } from "@/lib/services/courses";
import { toEmbedUrl } from "@/lib/courses/video";
import type { PchomepayClient, PchomepayQuery } from "@/lib/pay/pchomepay";
import type { Store } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
});

const PAID_VIDEO = "https://www.youtube.com/watch?v=PAIDvideo01";
const PAID_EMBED = "https://www.youtube-nocookie.com/embed/PAIDvideo01";

async function courseSite(store: Store, slug: string, opts: { pchomepay?: "sandbox" | "live"; price?: number } = {}) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: `學院 ${slug}`, modules: ["courses", "shop"] });
  await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "匯款" }, ownerEmail: "owner@example.com" } });
  await publishSite(ctx, { site: slug, confirm: true });
  if (opts.pchomepay) {
    await savePaymentAccount(ctx, { site: slug, appId: "APPID123", secret: "secret-value-123", sandbox: opts.pchomepay === "sandbox" });
    const t = (await store.getTenantBySlug(slug))!;
    await store.markPaymentAccount(t.id, "pchomepay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  }
  const c = await createCourse(ctx, { site: slug, slug: "tarot", title: "塔羅入門", price: opts.price ?? 2400 });
  await addLesson(ctx, { site: slug, courseSlug: "tarot", slug: "intro", title: "第一課（試看）", videoUrl: "https://youtu.be/FREEvideo01", isPreview: true, bodyMd: "歡迎" });
  await addLesson(ctx, { site: slug, courseSlug: "tarot", slug: "major", title: "大阿爾克那", videoUrl: PAID_VIDEO, bodyMd: "付費內容：愚者", attachments: [{ name: "講義", url: "https://example.com/handout.pdf" }] });
  await updateCourse(ctx, { site: slug, slug: "tarot", patch: { status: "published" }, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  await registerMember({ store, ipSecret: "x-secret-xxxxx", baseUrl: "http://t" }, { tenant, ip: "1.1.1.1", data: { email: `stu-${slug}@example.com`, password: "password-123", name: "學生" } });
  const member = (await store.getMemberByEmail(tenant.id, `stu-${slug}@example.com`))!;
  return { ctx, tenant, c, member };
}

const buy = (store: Store, x: Awaited<ReturnType<typeof courseSite>>, method: "offline" | "pchomepay" = "offline", allowSandbox = false) =>
  buyCourse({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: x.member, allowSandbox, data: { courseId: x.c.id, contact: { name: "學生", phone: "0912345678" }, paymentMethod: method } });

const q = (amount: number): PchomepayQuery => ({ status: "S", status_code: undefined, amount, raw: { status: "S", amount } });
const notifyBody = (gw: string) => new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: gw, status: "S" }) }).toString();

async function payOnline(store: Store, x: Awaited<ReturnType<typeof courseSite>>, sandbox: boolean) {
  const r = await buy(store, x, "pchomepay", sandbox);
  if (r.kind !== "order") throw new Error("expected order");
  const factory = async () => ({ sandbox, client: { createPayment: async () => ({ paymentUrl: "https://example.invalid/pay" }) } as unknown as PchomepayClient });
  const pay = await startPchomepayPayment({ store, baseUrl: "http://t", clientFactory: factory }, { tenant: x.tenant, order: r.order, accessKey: r.accessKey });
  const d: PayDeps = { store, baseUrl: "http://t", queryFor: async () => ({ queryPayment: async () => q(r.order.total) }) };
  return { order: r.order, notify: () => handlePchomepayNotify(d, { tenantId: x.tenant.id, rawBody: notifyBody(pay.gatewayOrderNo) }) };
}

describe("影片網址白名單", () => {
  it("YouTube／Vimeo 正規化成 embed；其他網域、http、亂碼拒絕", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://youtube.com/embed/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(toEmbedUrl("https://vimeo.com/123456789/abcdef1234")).toBe("https://player.vimeo.com/video/123456789?h=abcdef1234");
    expect(toEmbedUrl("https://player.vimeo.com/video/123456789")).toBe("https://player.vimeo.com/video/123456789");
    for (const bad of ["http://youtu.be/dQw4w9WgXcQ", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://youtu.be/short", "https://vimeo.com/abc"]) expect(toEmbedUrl(bad), bad).toBeNull();
  });
  it("add_lesson 拒絕白名單以外的影片網址", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-vid");
    await expect(addLesson(x.ctx, { site: "co-vid", courseSlug: "tarot", slug: "bad", title: "x", videoUrl: "https://evil.example/v.mp4", confirm: true })).rejects.toThrow(/YouTube/);
  });
});

describe("付款成功才開通", () => {
  it("線下匯款：未付款前看不到付費單元（物件與序列化結果都不含影片網址）；試看可看；mark_order_paid 後開通", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-off");
    const r = await buy(store, x);
    expect(r.kind).toBe("order");
    if (r.kind !== "order") return;
    expect((await store.listOrderItems(x.tenant.id, r.order.id))[0]).toMatchObject({ item_kind: "course", ref_id: x.c.id });
    const locked = (await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!;
    expect(locked.allowed).toBe(false);
    const blob = JSON.stringify(locked);
    expect(blob).not.toContain("PAIDvideo01");
    expect(blob).not.toContain("愚者");
    expect(blob).not.toContain("handout.pdf");
    const preview = (await lessonForViewer(store, x.tenant, "tarot", "intro", null))!;
    expect(preview.allowed).toBe(true);
    expect(preview.lesson.videoUrl).toBe("https://www.youtube-nocookie.com/embed/FREEvideo01");
    // 重複購買被擋（已有待付款訂單）
    await expect(buy(store, x)).rejects.toThrow(/待付款/);
    await markOrderPaid(x.ctx, { site: "co-off", orderNo: r.order.order_no, confirm: true });
    const open = (await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!;
    expect(open.allowed).toBe(true);
    expect(open.lesson.videoUrl).toBe(PAID_EMBED);
    expect(open.lesson.attachments).toHaveLength(1);
    await expect(buy(store, x)).rejects.toThrow(/已經擁有/);
  });

  it("PChomePay 正式環境：notify 權威回查已付 → 開通；重複 notify 只開通一次", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-live", { pchomepay: "live" });
    const p = await payOnline(store, x, false);
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(false);
    expect((await p.notify()).outcome).toBe("paid");
    expect((await p.notify()).outcome).toBe("already_processed");
    await Promise.all([p.notify(), p.notify()]);
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(true);
    expect((await store.listAudit(x.tenant.id, 200)).filter((a) => a.action === "course.grant_paid")).toHaveLength(1);
    expect((await store.listEnrollments(x.tenant.id, { courseId: x.c.id, limit: 10, offset: 0 })).total).toBe(1);
  });

  it("PChomePay sandbox 付款成功 → 訂單 paid（payment_sandbox），但不開通", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-sbx", { pchomepay: "sandbox" });
    const p = await payOnline(store, x, true);
    expect((await p.notify()).outcome).toBe("paid");
    const o = (await store.getOrderById(x.tenant.id, p.order.id))!;
    expect(o).toMatchObject({ status: "paid", payment_sandbox: true });
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(false);
    expect((await store.listEnrollments(x.tenant.id, { limit: 10, offset: 0 })).total).toBe(0);
  });

  it("已發布網站的一般訪客不能用 sandbox 金流購買（沒有預覽簽章）", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-sbx2", { pchomepay: "sandbox" });
    await expect(buy(store, x, "pchomepay", false)).rejects.toThrow(/無法使用線上付款/);
  });

  it("訂單取消 → 撤銷存取權（冪等）；手動開通的不受別張訂單取消影響", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-cancel");
    const r = (await buy(store, x)) as { order: { order_no: string; id: string } };
    await markOrderPaid(x.ctx, { site: "co-cancel", orderNo: r.order.order_no, confirm: true });
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(true);
    await cancelOrder(x.ctx, { site: "co-cancel", orderNo: r.order.order_no, confirm: true });
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(false);
    expect(await store.revokeEnrollment(x.tenant.id, { orderId: r.order.id }, { by: "x", reason: "again" })).toEqual([]);
    // 手動開通（confirm）→ 再撤銷（confirm）
    await expect(grantCourse(x.ctx, { site: "co-cancel", courseSlug: "tarot", email: x.member.email })).rejects.toMatchObject({ code: "confirm_required" });
    expect((await grantCourse(x.ctx, { site: "co-cancel", courseSlug: "tarot", email: x.member.email, confirm: true })).granted).toBe(true);
    expect((await grantCourse(x.ctx, { site: "co-cancel", courseSlug: "tarot", email: x.member.email, confirm: true })).granted).toBe(false);
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(true);
    const le = await listEnrollments(x.ctx, { site: "co-cancel" });
    expect(le.enrollments[0]).toMatchObject({ status: "active", source: "manual" });
    expect(le.enrollments[0]!.member).toContain("＊");
    await expect(revokeCourse(x.ctx, { site: "co-cancel", courseSlug: "tarot", email: x.member.email })).rejects.toMatchObject({ code: "confirm_required" });
    expect((await revokeCourse(x.ctx, { site: "co-cancel", courseSlug: "tarot", email: x.member.email, confirm: true })).revoked).toBe(1);
    expect((await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!.allowed).toBe(false);
  });
});

describe("學員端：進度、免費課程、草稿單元", () => {
  it("完成單元（冪等）；未開通不能記錄；免費課程登入即可加入；需要登入", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-free", { price: 0 });
    await expect(markLessonComplete(store, x.tenant, x.member, "tarot", "major")).rejects.toMatchObject({ code: "forbidden" });
    await expect(buyCourse({ store, baseUrl: "http://t" }, { tenant: x.tenant, member: null, data: { courseId: x.c.id, contact: { name: "a", phone: "0912345678" } } })).rejects.toMatchObject({ code: "unauthorized" });
    expect((await buy(store, x)).kind).toBe("enrolled");
    await markLessonComplete(store, x.tenant, x.member, "tarot", "major");
    await markLessonComplete(store, x.tenant, x.member, "tarot", "major");
    const v = (await lessonForViewer(store, x.tenant, "tarot", "major", x.member))!;
    expect(v.lesson.done).toBe(true);
    expect(v.outline.filter((o) => o.done)).toHaveLength(1);
    // 草稿單元不出現在前台
    const l = (await store.listLessons(x.tenant.id, [x.c.id])).find((y) => y.slug === "major")!;
    await updateLesson(x.ctx, { site: "co-free", lessonId: l.id, patch: { status: "draft" }, confirm: true });
    expect(await lessonForViewer(store, x.tenant, "tarot", "major", x.member)).toBeNull();
  });
});

describe("隔離、scope、confirm", () => {
  it("A 站的課程與開通在 B 站不可見；同 email 的 B 站會員沒有 A 站課程", async () => {
    const store = newStore();
    const a = await courseSite(store, "co-iso-a");
    const b = await courseSite(store, "co-iso-b");
    await grantCourse(a.ctx, { site: "co-iso-a", courseSlug: "tarot", email: a.member.email, confirm: true });
    expect(await lessonForViewer(store, b.tenant, "tarot", "major", a.member)).not.toBeNull(); // B 自己也有同 slug 的課
    expect((await lessonForViewer(store, b.tenant, "tarot", "major", a.member))!.allowed).toBe(false); // A 的會員在 B 站沒權限
    expect((await listEnrollments(b.ctx, { site: "co-iso-b" })).total).toBe(0);
    await expect(grantCourse(b.ctx, { site: "co-iso-b", courseSlug: "tarot", memberId: a.member.id, confirm: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("scope：沒有 attendees:write 不能開通；沒有 publish 不能上架；沒有 attendees:read 不能讀學員", async () => {
    const store = newStore();
    const x = await courseSite(store, "co-scope");
    const actor = (scopes: Actor["scopes"]): Actor => ({ kind: "token", label: "t", tenantId: x.tenant.id, scopes });
    await expect(grantCourse({ ...x.ctx, actor: actor(["classes:write"]) }, { courseSlug: "tarot", email: x.member.email, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createCourse({ ...x.ctx, actor: actor(["classes:write"]) }, { slug: "x", title: "X", status: "published", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listEnrollments({ ...x.ctx, actor: actor(["site:read"]) }, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateCourse({ ...x.ctx, actor: actor(["classes:write", "publish"]) }, { slug: "tarot", patch: { price: 1 } })).rejects.toMatchObject({ code: "confirm_required" });
  });
});
