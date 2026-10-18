import { z } from "zod";
import type { ModuleManifest } from "../types";
import { optText, postSlug } from "@/lib/validators";

/** 課程設定（configure_module，進草稿、發布後生效） */
export const coursesSettings = z
  .object({
    /** 開課通知信箱（不填用 shop 的 ownerEmail） */
    ownerEmail: z.email({ message: "通知信箱格式不正確" }).optional(),
  })
  .strict();
export type CoursesSettings = z.output<typeof coursesSettings>;

export const coursesListProps = z
  .object({
    heading: optText(120),
    limit: z.number().int().min(1).max(30).default(6),
    showAllLink: z.boolean().default(true),
  })
  .strict();

export const courseDetailProps = z
  .object({
    courseSlug: postSlug,
    heading: optText(120),
  })
  .strict();

export const manifest: ModuleManifest = {
  id: "courses",
  name: "線上課程",
  description:
    "課程 → 單元（YouTube／Vimeo 未公開影片、Markdown 內容、附件、免費試看）。購買走既有訂單＋付款（需 shop），付款成功（權威回查確認）才自動開通、sandbox 付款不開通、訂單取消自動撤銷；店主也可手動開通／撤銷。會員中心「我的課程」、上課頁、完成進度。未開通者在伺服器端就拿不到付費單元內容與影片網址。頁面 /courses、/courses/<課程>、/learn/<課程>/<單元>。",
  category: "commerce",
  priceSetup: 15000,
  priceMonthly: 1000,
  requires: ["core", "members"],
  settingsSchema: coursesSettings,
  sectionTypes: [
    {
      type: "courses_list",
      label: "課程列表",
      description: "列出已上架課程（封面、標題、價格、單元數），連到 /courses/<slug>。",
      schema: coursesListProps,
      example: { heading: "線上課程", limit: 6, showAllLink: true },
    },
    {
      type: "course_detail",
      label: "單一課程",
      description: "在任何頁面嵌入一門課程的介紹、單元列表與購買／上課按鈕。courseSlug 為課程 slug。",
      schema: courseDetailProps,
      example: { courseSlug: "example-course" },
    },
  ],
  adminPages: [{ path: "courses", label: "課程" }],
  mcpTools: ["create_course", "update_course", "add_lesson", "update_lesson", "list_courses", "grant_course", "revoke_course", "list_enrollments"],
};
