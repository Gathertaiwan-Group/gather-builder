import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { referralActive } from "@/lib/services/referral";
import { referralCookieName } from "@/lib/shop-routes";
import { baseUrlFrom } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** 推薦分享連結：記住推薦碼（HttpOnly cookie、只在這個網站、30 天）後導回首頁。結帳時 server 只從 cookie 讀推薦碼。 */
export async function GET(req: Request, { params }: { params: Promise<{ site: string; code: string }> }) {
  const { site, code } = await params;
  const slug = site.toLowerCase();
  const store = getStore();
  const tenant = await store.getTenantBySlug(slug);
  const home = NextResponse.redirect(new URL(`/s/${slug}`, baseUrlFrom(req)), 303);
  if (!tenant || tenant.status === "suspended") return new NextResponse("not found", { status: 404 });
  const c = code.toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(c) || !(await referralActive(store, tenant.id)) || !(await store.getReferralCodeByCode(tenant.id, c))) return home;
  home.cookies.set(referralCookieName(tenant.id), c, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: `/s/${slug}`, maxAge: 30 * 86400 });
  return home;
}
