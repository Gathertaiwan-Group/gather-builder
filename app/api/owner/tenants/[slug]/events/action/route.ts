// 店主後台與平台後台共用同一個 route（身分與權限由 lib/backoffice.ts 依入口決定）
export const dynamic = "force-dynamic";
export { POST } from "@/app/api/admin/tenants/[slug]/events/action/route";
