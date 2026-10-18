import { z } from "zod";
import type { CourseRow, EnrollmentRow, LessonRow, MemberRow, OrderRow, Store, TenantRow } from "../store/types";
import type { CoursesSettings } from "@/modules/courses/manifest";
import { imageUrl, optText, postSlug, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, publishedShopSettings, type CheckoutDeps } from "./shop";
import { registerOrderHooks, type CancelDeps, type HookDeps } from "./order-hooks";
import { maskEmail, placeClassOrder, shopActive } from "./class-orders";
import { toEmbedUrl } from "../courses/video";

/* ================================================================== 共用 */

export async function coursesActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("courses");
}
async function requireCourses(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await coursesActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「courses」，請先 enable_module courses");
}
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請維持 draft。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

const videoUrl = z
  .string()
  .trim()
  .max(500)
  .transform((v, c) => {
    const e = toEmbedUrl(v);
    if (!e) {
      c.addIssue({ code: "custom", message: "影片網址只接受 YouTube（含未公開連結）或 Vimeo 的 https 網址" });
      return z.NEVER;
    }
    return e;
  });
const attachment = z.object({ name: text(120), url: z.string().trim().max(1000).regex(/^https:\/\//, { message: "附件網址需為 https://" }) }).strict();

export const courseInput = z
  .object({
    slug: postSlug,
    title: text(160),
    summary: optText(300),
    bodyMd: z.string().max(50_000).default(""),
    coverUrl: imageUrl.optional(),
    price: z.number().int().min(0).max(1_000_000).default(0),
    status: z.enum(["draft", "published"]).default("draft"),
    sort: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

export const lessonInput = z
  .object({
    slug: postSlug,
    title: text(160),
    videoUrl: videoUrl.optional(),
    bodyMd: z.string().max(100_000).default(""),
    attachments: z.array(attachment).max(20).default([]),
    /** 免費試看（未購買也看得到） */
    isPreview: z.boolean().default(false),
    status: z.enum(["draft", "published"]).default("published"),
    sort: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

function courseSummary(c: CourseRow, lessons?: LessonRow[]) {
  return { id: c.id, slug: c.slug, title: c.title, price: c.price, status: c.status, summary: c.summary, coverUrl: c.cover_url, lessons: lessons?.map((l) => ({ id: l.id, slug: l.slug, title: l.title, isPreview: l.is_preview, status: l.status, hasVideo: !!l.video_url, attachments: l.attachments.length, sort: l.sort })) };
}

async function findCourse(ctx: ServiceContext, tenant: TenantRow, ref: { courseId?: string; slug?: string; courseSlug?: string }) {
  const slug = ref.slug ?? ref.courseSlug;
  const c = ref.courseId ? await ctx.store.getCourseById(tenant.id, ref.courseId) : slug ? await ctx.store.getCourseBySlug(tenant.id, slug) : null;
  if (!c) throw new ServiceError("not_found", "找不到課程（請給 courseId 或 slug）");
  return c;
}

/* ================================================================== 課程／單元（MCP＋後台） */

export async function createCourse(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof courseInput>) {
  requireScope(ctx, "classes:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireCourses(ctx, tenant);
  const d = parse(courseInput, rest);
  if (d.price > 0 && !(await shopActive(ctx.store, tenant.id))) throw new ServiceError("invalid", "付費課程需要先啟用 shop 模組（線下匯款或 PChomePay）：enable_module shop");
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架課程", confirm);
  if (await ctx.store.getCourseBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `課程 slug「${d.slug}」已存在`);
  const row = await ctx.store.insertCourse({ tenant_id: tenant.id, slug: d.slug, title: d.title, summary: d.summary ?? null, body_md: d.bodyMd, cover_url: d.coverUrl ?? null, price: d.price, status: d.status, sort: d.sort });
  await audit(ctx, tenant.id, "course.create", { courseId: row.id, slug: row.slug });
  return { ...courseSummary(row, []), note: "課程已建立。用 add_lesson 加單元（影片網址只接受 YouTube／Vimeo），再用 update_course 上架。" };
}

export async function updateCourse(ctx: ServiceContext, input: { site?: string | null; courseId?: string; slug?: string; confirm?: boolean; patch: Partial<z.input<typeof courseInput>> }) {
  requireScope(ctx, "classes:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCourses(ctx, tenant);
  const c = await findCourse(ctx, tenant, input);
  const given = input.patch ?? {};
  const p = parse(courseInput.partial().strict(), given);
  if ((given.status ?? c.status) === "published" || c.status === "published") requireLiveConfirm(ctx, "修改／上架／下架已上架的課程", input.confirm);
  if ((p.price ?? c.price) > 0 && !(await shopActive(ctx.store, tenant.id))) throw new ServiceError("invalid", "付費課程需要先啟用 shop 模組");
  if (p.slug && p.slug !== c.slug && (await ctx.store.getCourseBySlug(tenant.id, p.slug))) throw new ServiceError("conflict", `課程 slug「${p.slug}」已存在`);
  const patch: Parameters<Store["updateCourse"]>[2] = {};
  if (given.slug !== undefined) patch.slug = p.slug;
  if (given.title !== undefined) patch.title = p.title;
  if (given.summary !== undefined) patch.summary = p.summary ?? null;
  if (given.bodyMd !== undefined) patch.body_md = p.bodyMd;
  if (given.coverUrl !== undefined) patch.cover_url = p.coverUrl ?? null;
  if (given.price !== undefined) patch.price = p.price;
  if (given.status !== undefined) patch.status = p.status;
  if (given.sort !== undefined) patch.sort = p.sort;
  const row = (await ctx.store.updateCourse(tenant.id, c.id, patch))!;
  await audit(ctx, tenant.id, "course.update", { courseId: c.id, keys: Object.keys(given) });
  return courseSummary(row, await ctx.store.listLessons(tenant.id, [c.id]));
}

export async function addLesson(ctx: ServiceContext, input: { site?: string | null; courseId?: string; courseSlug?: string; confirm?: boolean } & z.input<typeof lessonInput>) {
  requireScope(ctx, "classes:write");
  const { site, courseId, courseSlug, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireCourses(ctx, tenant);
  const c = await findCourse(ctx, tenant, { courseId, courseSlug });
  const d = parse(lessonInput, rest);
  if (c.status === "published" && d.status === "published") requireLiveConfirm(ctx, "為已上架課程新增公開單元", confirm);
  if (await ctx.store.getLessonBySlug(tenant.id, c.id, d.slug)) throw new ServiceError("conflict", `單元 slug「${d.slug}」已存在`);
  const row = await ctx.store.insertLesson({ tenant_id: tenant.id, course_id: c.id, slug: d.slug, title: d.title, video_url: d.videoUrl ?? null, body_md: d.bodyMd, attachments: d.attachments, is_preview: d.isPreview, status: d.status, sort: d.sort });
  await audit(ctx, tenant.id, "course.lesson.add", { courseId: c.id, lessonId: row.id });
  return { id: row.id, slug: row.slug, title: row.title, isPreview: row.is_preview, status: row.status, videoEmbed: row.video_url };
}

export async function updateLesson(ctx: ServiceContext, input: { site?: string | null; lessonId: string; confirm?: boolean; patch: Partial<z.input<typeof lessonInput>> }) {
  requireScope(ctx, "classes:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCourses(ctx, tenant);
  const l = await ctx.store.getLesson(tenant.id, input.lessonId);
  if (!l) throw new ServiceError("not_found", "找不到單元");
  const c = (await ctx.store.getCourseById(tenant.id, l.course_id))!;
  const given = input.patch ?? {};
  const p = parse(lessonInput.partial().strict(), given);
  if (c.status === "published") requireLiveConfirm(ctx, "修改已上架課程的單元", input.confirm);
  if (p.slug && p.slug !== l.slug && (await ctx.store.getLessonBySlug(tenant.id, c.id, p.slug))) throw new ServiceError("conflict", `單元 slug「${p.slug}」已存在`);
  const patch: Parameters<Store["updateLesson"]>[2] = {};
  if (given.slug !== undefined) patch.slug = p.slug;
  if (given.title !== undefined) patch.title = p.title;
  if (given.videoUrl !== undefined) patch.video_url = p.videoUrl ?? null;
  if (given.bodyMd !== undefined) patch.body_md = p.bodyMd;
  if (given.attachments !== undefined) patch.attachments = p.attachments;
  if (given.isPreview !== undefined) patch.is_preview = p.isPreview;
  if (given.status !== undefined) patch.status = p.status;
  if (given.sort !== undefined) patch.sort = p.sort;
  const row = (await ctx.store.updateLesson(tenant.id, l.id, patch))!;
  await audit(ctx, tenant.id, "course.lesson.update", { lessonId: l.id, keys: Object.keys(given) });
  return { id: row.id, slug: row.slug, title: row.title, isPreview: row.is_preview, status: row.status, videoEmbed: row.video_url };
}

export async function listCourses(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCourses(ctx, tenant);
  const cs = await ctx.store.listCourses(tenant.id, {});
  const ls = await ctx.store.listLessons(tenant.id, cs.map((c) => c.id));
  const counts = await Promise.all(cs.map(async (c) => (await ctx.store.listEnrollments(tenant.id, { courseId: c.id, status: "active", limit: 1, offset: 0 })).total));
  return { courses: cs.map((c, i) => ({ ...courseSummary(c, ls.filter((l) => l.course_id === c.id)), activeEnrollments: counts[i] })) };
}

/* ================================================================== 開通／撤銷 */

async function memberRef(ctx: ServiceContext, tenant: TenantRow, ref: { memberId?: string; email?: string }) {
  const m = ref.memberId ? await ctx.store.getMemberById(tenant.id, ref.memberId) : ref.email ? await ctx.store.getMemberByEmail(tenant.id, ref.email.trim().toLowerCase()) : null;
  if (!m) throw new ServiceError("not_found", "找不到會員（請給 memberId 或 email；對方要先在網站註冊會員）");
  return m;
}

/** 店主手動開通（confirm）：例如線下收款、贈送 */
export async function grantCourse(ctx: ServiceContext, input: { site?: string | null; courseId?: string; courseSlug?: string; memberId?: string; email?: string; confirm?: boolean }) {
  requireScope(ctx, "attendees:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCourses(ctx, tenant);
  const c = await findCourse(ctx, tenant, input);
  const m = await memberRef(ctx, tenant, input);
  if (input.confirm !== true) throw new ServiceError("confirm_required", `為 ${maskEmail(m.email)} 開通課程「${c.title}」（不經過付款）。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const r = await ctx.store.grantEnrollment(tenant.id, { courseId: c.id, memberId: m.id, source: "manual", orderId: null, by: ctx.actor.label });
  await audit(ctx, tenant.id, "course.grant", { courseId: c.id, memberId: m.id, granted: r.granted });
  return { enrollmentId: r.id, granted: r.granted, note: r.granted ? "已開通。" : "這位會員已經開通過了（不重複開通）。" };
}

export async function revokeCourse(ctx: ServiceContext, input: { site?: string | null; courseId?: string; courseSlug?: string; memberId?: string; email?: string; reason?: string; confirm?: boolean }) {
  requireScope(ctx, "attendees:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCourses(ctx, tenant);
  const c = await findCourse(ctx, tenant, input);
  const m = await memberRef(ctx, tenant, input);
  if (input.confirm !== true) throw new ServiceError("confirm_required", `撤銷 ${maskEmail(m.email)} 的課程「${c.title}」存取權（不會自動退款）。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const rows = await ctx.store.revokeEnrollment(tenant.id, { courseId: c.id, memberId: m.id }, { by: ctx.actor.label, reason: input.reason?.slice(0, 200) || "店主撤銷" });
  await audit(ctx, tenant.id, "course.revoke", { courseId: c.id, memberId: m.id, revoked: rows.length });
  return { revoked: rows.length, note: rows.length ? "已撤銷存取權。" : "這位會員目前沒有這門課的存取權。" };
}

export async function listEnrollments(ctx: ServiceContext, input: { site?: string | null; courseId?: string; courseSlug?: string; status?: "active" | "revoked" }) {
  requireScope(ctx, "attendees:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCourses(ctx, tenant);
  const c = input.courseId || input.courseSlug ? await findCourse(ctx, tenant, input) : null;
  const r = await ctx.store.listEnrollments(tenant.id, { courseId: c?.id, status: input.status, limit: 500, offset: 0 });
  const cs = await ctx.store.listCourses(tenant.id, {});
  const out = await Promise.all(
    r.rows.map(async (e) => {
      const m = await ctx.store.getMemberById(tenant.id, e.member_id);
      const done = (await ctx.store.listProgress(tenant.id, e.member_id, e.course_id)).length;
      return { id: e.id, course: cs.find((x) => x.id === e.course_id)?.title ?? null, member: m ? maskEmail(m.email) : null, memberId: e.member_id, status: e.status, source: e.source, orderId: e.order_id, grantedAt: e.granted_at, revokedAt: e.revoked_at, lessonsCompleted: done };
    }),
  );
  return { total: r.total, enrollments: out, note: "會員 email 已遮罩。" };
}

/* ================================================================== 前台：購買、上課、進度 */

export async function canAccessCourse(store: Store, tenant: TenantRow, course: CourseRow, member: MemberRow | null): Promise<boolean> {
  if (!member) return false;
  const e = await store.getEnrollment(tenant.id, course.id, member.id);
  return e?.status === "active";
}

/**
 * 上課頁的權威存取判斷（server 端）：試看單元任何人可看；其他單元必須是已開通（active）的會員。
 * 🔴 未開通時回傳的 lesson 物件不含 videoUrl／body／附件——頁面只能用這裡回傳的東西渲染，影片網址不會出現在 HTML。
 */
export async function lessonForViewer(store: Store, tenant: TenantRow, courseSlug: string, lessonSlug: string, member: MemberRow | null, opts: { preview?: boolean } = {}) {
  const course = await store.getCourseBySlug(tenant.id, courseSlug);
  if (!course || (course.status !== "published" && !opts.preview)) return null;
  const lessons = (await store.listLessons(tenant.id, [course.id])).filter((l) => l.status === "published" || opts.preview);
  const lesson = lessons.find((l) => l.slug === lessonSlug);
  if (!lesson) return null;
  const enrolled = await canAccessCourse(store, tenant, course, member);
  const allowed = enrolled || lesson.is_preview;
  const done = member && enrolled ? new Set((await store.listProgress(tenant.id, member.id, course.id)).map((p) => p.lesson_id)) : new Set<string>();
  return {
    course,
    enrolled,
    allowed,
    outline: lessons.map((l) => ({ slug: l.slug, title: l.title, isPreview: l.is_preview, done: done.has(l.id) })),
    lesson: allowed
      ? { id: lesson.id, slug: lesson.slug, title: lesson.title, isPreview: lesson.is_preview, videoUrl: lesson.video_url, bodyMd: lesson.body_md, attachments: lesson.attachments, done: done.has(lesson.id) }
      : { id: lesson.id, slug: lesson.slug, title: lesson.title, isPreview: false, videoUrl: null, bodyMd: "", attachments: [], done: false },
  };
}

export async function markLessonComplete(store: Store, tenant: TenantRow, member: MemberRow | null, courseSlug: string, lessonSlug: string) {
  if (!member) throw new ServiceError("unauthorized", "請先登入會員");
  const v = await lessonForViewer(store, tenant, courseSlug, lessonSlug, member);
  if (!v || !v.enrolled) throw new ServiceError("forbidden", "你還沒有這門課的存取權");
  await store.markLessonDone({ tenant_id: tenant.id, course_id: v.course.id, lesson_id: v.lesson.id, member_id: member.id });
  return { done: true };
}

export const buyInput = z
  .object({
    courseId: z.string().trim().min(1).max(64),
    contact: z.object({ name: text(80), phone: z.string().trim().min(6, { message: "請填寫電話" }).max(40) }).strict(),
    paymentMethod: z.enum(["offline", "pchomepay"]).optional(),
    couponCode: z.string().trim().max(32).optional(),
    referralCode: z.string().trim().max(16).optional(),
  })
  .strict();

export type BuyResult = { kind: "enrolled"; course: CourseRow } | { kind: "order"; order: OrderRow; accessKey: string; orderUrl: string };

/** 購買（必須登入會員：存取權綁會員）。免費課程直接開通；付費 → 建訂單，付款成功 hook 才開通 */
export async function buyCourse(deps: CheckoutDeps, input: { tenant: TenantRow; member: MemberRow | null; data: unknown; allowSandbox?: boolean }): Promise<BuyResult> {
  const { tenant, member } = input;
  if (!(await coursesActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放線上課程");
  if (!member) throw new ServiceError("unauthorized", "請先登入會員再購買課程（上課需要會員帳號）");
  const d = parse(buyInput, input.data);
  const c = await deps.store.getCourseById(tenant.id, d.courseId);
  if (!c || c.status !== "published") throw new ServiceError("not_found", "找不到這門課程");
  if (await canAccessCourse(deps.store, tenant, c, member)) throw new ServiceError("conflict", "你已經擁有這門課程了，直接到會員中心上課即可");
  if (c.price === 0) {
    await deps.store.grantEnrollment(tenant.id, { courseId: c.id, memberId: member.id, source: "free", orderId: null, by: `member:${member.id}` });
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: `member:${member.id}`, action: "course.enroll_free", payload: { courseId: c.id } });
    return { kind: "enrolled", course: c };
  }
  // 避免重複付款：同一會員已有這門課的待付款訂單
  const pending = (await deps.store.listOrders(tenant.id, { memberId: member.id, status: "pending_payment", limit: 20, offset: 0 })).rows;
  for (const o of pending) {
    if (o.expires_at && new Date(o.expires_at).getTime() <= Date.now()) continue;
    const items = await deps.store.listOrderItems(tenant.id, o.id);
    if (items.some((i) => i.item_kind === "course" && i.ref_id === c.id)) throw new ServiceError("conflict", `你已經有一張這門課的待付款訂單（${o.order_no}），請先完成付款`);
  }
  const r = await placeClassOrder(deps, {
    tenant,
    member,
    contact: { name: d.contact.name, email: member.email, phone: d.contact.phone },
    item: { item_kind: "course", ref_id: c.id, name: c.title, variant_label: "線上課程", sku: null, unit_price: c.price, qty: 1, line_total: c.price },
    reservation: null,
    paymentMethod: d.paymentMethod ?? "offline",
    couponCode: d.couponCode,
    referralCode: d.referralCode,
    allowSandbox: input.allowSandbox,
  });
  return { kind: "order", order: r.order, accessKey: r.accessKey, orderUrl: r.orderUrl };
}

/* ================================================================== hooks：付款成功才開通、取消撤銷 */

/**
 * 付款成功（只在訂單真正轉成 paid 的那一次、且不是 sandbox 付款——onOrderPaid 對 sandbox 不跑 hook）→ 開通。
 * 冪等：builder_grant_enrollment 已開通就不動；重複 notify 不會走到這裡（條件式轉換只成功一次），就算走到也不會重複開。
 */
export async function onCourseOrderPaid(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  if (!order.member_id || order.payment_sandbox) return;
  const items = (await deps.store.listOrderItems(tenant.id, order.id)).filter((i) => i.item_kind === "course" && i.ref_id);
  for (const it of items) {
    const r = await deps.store.grantEnrollment(tenant.id, { courseId: it.ref_id!, memberId: order.member_id, source: "order", orderId: order.id, by: "system:order" });
    if (!r.granted) continue;
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:courses", action: "course.grant_paid", payload: { orderNo: order.order_no, courseId: it.ref_id } });
    const c = await deps.store.getCourseById(tenant.id, it.ref_id!);
    if (c) {
      await mailSafe(deps, order.contact.email, `【${tenant.name}】課程已開通：${c.title}`, `${order.contact.name} 你好，\n\n「${c.title}」已開通，登入會員中心即可開始上課：\n${deps.baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/account`);
      const owner = ((await publishedModuleSettings(deps.store, tenant, "courses")) as CoursesSettings).ownerEmail ?? (await publishedShopSettings(deps.store, tenant)).ownerEmail;
      if (owner) await mailSafe(deps, owner, `【${tenant.name}】課程售出：${c.title}（${order.order_no}）`, `學員：${maskEmail(order.contact.email)}`);
    }
  }
}

/** 訂單取消／逾期（含已付款後取消）→ 撤銷「由這張訂單開通」的存取權（冪等：只動 active） */
export async function onCourseOrderCancelled(store: Store, tenant: TenantRow, order: OrderRow, _cd?: CancelDeps) {
  const revoked: EnrollmentRow[] = await store.revokeEnrollment(tenant.id, { orderId: order.id }, { by: "system:order", reason: order.cancel_reason ?? "order_cancelled" });
  for (const e of revoked) await store.insertAudit({ tenant_id: tenant.id, actor: "system:courses", action: "course.revoke_cancelled", payload: { orderNo: order.order_no, courseId: e.course_id } });
}

registerOrderHooks({ name: "courses", paid: onCourseOrderPaid, cancelled: onCourseOrderCancelled });

/* ================================================================== 前台列表、會員中心 */

export async function publicCourses(store: Store, tenant: TenantRow) {
  const cs = await store.listCourses(tenant.id, { status: "published" });
  const ls = await store.listLessons(tenant.id, cs.map((c) => c.id));
  return cs.map((c) => ({ course: c, lessons: ls.filter((l) => l.course_id === c.id && l.status === "published").map((l) => ({ slug: l.slug, title: l.title, isPreview: l.is_preview })) }));
}

export async function memberCourses(store: Store, tenant: TenantRow, member: MemberRow) {
  const r = await store.listEnrollments(tenant.id, { memberId: member.id, status: "active", limit: 100, offset: 0 });
  const out = [];
  for (const e of r.rows) {
    const c = await store.getCourseById(tenant.id, e.course_id);
    if (!c) continue;
    const ls = (await store.listLessons(tenant.id, [c.id])).filter((l) => l.status === "published");
    const done = (await store.listProgress(tenant.id, member.id, c.id)).length;
    out.push({ course: c, total: ls.length, done, first: ls[0]?.slug ?? null });
  }
  return out;
}

