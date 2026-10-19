// 店主後台與平台後台共用同一個頁面（身分與權限由 lib/backoffice.ts 依入口決定）
export const dynamic = "force-dynamic";
export { default } from "@/app/admin/t/[slug]/booking/page";
