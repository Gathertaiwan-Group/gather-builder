import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { ClassesStore, CourseRow, EnrollmentRow, LessonRow } from "./types-classes";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type CourseKeys =
  | "insertCourse" | "updateCourse" | "getCourseById" | "getCourseBySlug" | "listCourses" | "insertLesson" | "updateLesson" | "getLesson" | "getLessonBySlug" | "listLessons"
  | "grantEnrollment" | "revokeEnrollment" | "getEnrollment" | "listEnrollments" | "markLessonDone" | "listProgress";

function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複：同名的 slug 或識別碼已存在，請換一個");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string | null | undefined) => !!s && UUID.test(s);
const nowIso = () => new Date().toISOString();

/** courses 的 Supabase 實作（所有查詢都帶 tenant_id） */
export function createSupabaseCoursesStore(db: SupabaseClient): Pick<ClassesStore, CourseKeys> {
  return {
    async insertCourse(row) {
      return must(await db.from("builder_courses").insert(row).select("*").single(), "insertCourse") as CourseRow;
    },
    async updateCourse(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_courses").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateCourse") as CourseRow | null;
    },
    async getCourseById(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_courses").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getCourseById") as CourseRow | null;
    },
    async getCourseBySlug(tenantId, slug) {
      return must(await db.from("builder_courses").select("*").eq("tenant_id", tenantId).eq("slug", slug).maybeSingle(), "getCourseBySlug") as CourseRow | null;
    },
    async listCourses(tenantId, opts) {
      let q = db.from("builder_courses").select("*").eq("tenant_id", tenantId);
      if (opts.status) q = q.eq("status", opts.status);
      return (must(await q.order("sort").order("created_at"), "listCourses") ?? []) as CourseRow[];
    },
    async insertLesson(row) {
      return must(await db.from("builder_course_lessons").insert(row).select("*").single(), "insertLesson") as LessonRow;
    },
    async updateLesson(tenantId, id, patch) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_course_lessons").update({ ...patch, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("id", id).select("*").maybeSingle(), "updateLesson") as LessonRow | null;
    },
    async getLesson(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_course_lessons").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getLesson") as LessonRow | null;
    },
    async getLessonBySlug(tenantId, courseId, slug) {
      if (!isUuid(courseId)) return null;
      return must(await db.from("builder_course_lessons").select("*").eq("tenant_id", tenantId).eq("course_id", courseId).eq("slug", slug).maybeSingle(), "getLessonBySlug") as LessonRow | null;
    },
    async listLessons(tenantId, courseIds) {
      const ids = courseIds.filter(isUuid);
      if (!ids.length) return [];
      return (must(await db.from("builder_course_lessons").select("*").eq("tenant_id", tenantId).in("course_id", ids).order("sort").order("created_at"), "listLessons") ?? []) as LessonRow[];
    },
    async grantEnrollment(tenantId, input) {
      const r = await db.rpc("builder_grant_enrollment", { p_tenant: tenantId, p_course: input.courseId, p_member: input.memberId, p_source: input.source, p_order: input.orderId, p_by: input.by });
      if (r.error) throw new Error(`grantEnrollment: ${r.error.message}`);
      const row = (r.data as { enrollment_id: string; granted: boolean }[])[0]!;
      return { id: row.enrollment_id, granted: row.granted };
    },
    async revokeEnrollment(tenantId, where, patch) {
      if (!where.id && !where.orderId && !(where.courseId && where.memberId)) return [];
      let q = db.from("builder_course_enrollments").update({ status: "revoked", revoked_at: nowIso(), revoked_by: patch.by, revoke_reason: patch.reason, updated_at: nowIso() }).eq("tenant_id", tenantId).eq("status", "active");
      if (where.id) q = q.eq("id", where.id);
      if (where.orderId) q = q.eq("order_id", where.orderId);
      if (where.courseId) q = q.eq("course_id", where.courseId);
      if (where.memberId) q = q.eq("member_id", where.memberId);
      return (must(await q.select("*"), "revokeEnrollment") ?? []) as EnrollmentRow[];
    },
    async getEnrollment(tenantId, courseId, memberId) {
      if (!isUuid(courseId) || !isUuid(memberId)) return null;
      return must(await db.from("builder_course_enrollments").select("*").eq("tenant_id", tenantId).eq("course_id", courseId).eq("member_id", memberId).maybeSingle(), "getEnrollment") as EnrollmentRow | null;
    },
    async listEnrollments(tenantId, opts) {
      let q = db.from("builder_course_enrollments").select("*", { count: "exact" }).eq("tenant_id", tenantId);
      if (opts.courseId) q = q.eq("course_id", opts.courseId);
      if (opts.memberId) q = q.eq("member_id", opts.memberId);
      if (opts.status) q = q.eq("status", opts.status);
      const r = await q.order("granted_at", { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
      if (r.error) throw new Error(`listEnrollments: ${r.error.message}`);
      return { rows: (r.data ?? []) as EnrollmentRow[], total: r.count ?? 0 };
    },
    async markLessonDone(row) {
      must(await db.from("builder_course_progress").upsert(row, { onConflict: "member_id,lesson_id", ignoreDuplicates: true }), "markLessonDone");
    },
    async listProgress(tenantId, memberId, courseId) {
      return (must(await db.from("builder_course_progress").select("lesson_id, completed_at").eq("tenant_id", tenantId).eq("member_id", memberId).eq("course_id", courseId), "listProgress") ?? []) as { lesson_id: string; completed_at: string }[];
    },
  };
}
