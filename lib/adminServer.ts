import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, verifySessionValue } from "./adminAuth";
import { adminActor } from "./tokens";
import { makeContext } from "./runtime";

/** 第二道防線：middleware 之外，後台頁面與 API 自己再驗一次 */
export async function isAdmin(): Promise<boolean> {
  const c = await cookies();
  return verifySessionValue(c.get(ADMIN_COOKIE)?.value, process.env.ADMIN_SESSION_SECRET);
}

export async function requireAdminPage() {
  if (!(await isAdmin())) redirect("/admin/login");
}

export function adminContext(req?: { headers: Headers } | null) {
  return makeContext(adminActor(), req);
}

export const FLASH_COOKIE = "gb_flash";
