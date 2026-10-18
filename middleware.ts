import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, verifySessionValue } from "@/lib/adminAuth";
import { LANG_CODES } from "@/lib/i18n/langs";

const LANG_PATH = new RegExp(`^/s/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])/(${LANG_CODES.join("|")})(/.*)?$`);

/**
 * 1. 租戶網站多語（i18n）：/s/<slug>/<lang>/… → 改寫成 /s/<slug>/…，用 request header x-gb-lang 告訴頁面語言
 *    （頁面再確認該語言有啟用，否則 404）。站內 API（/s/<slug>/<lang>/api…）不改寫。客戶端自己送的 x-gb-lang 一律移除。
 * 2. 擋 /admin 與 /api/admin（登入頁與登入 API 除外）；後台 POST 另外檢查 Origin 防 CSRF。
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/s/")) {
    const headers = new Headers(req.headers);
    headers.delete("x-gb-lang");
    const m = LANG_PATH.exec(pathname);
    if (m && !(m[3] ?? "").startsWith("/api")) {
      headers.set("x-gb-lang", m[2]!);
      const url = req.nextUrl.clone();
      url.pathname = `/s/${m[1]}${m[3] ?? ""}`;
      return NextResponse.rewrite(url, { request: { headers } });
    }
    return NextResponse.next({ request: { headers } });
  }
  if (pathname === "/admin/login" || pathname === "/api/admin/login") return NextResponse.next();

  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) {
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      if (!host || new URL(origin).host !== host) return new NextResponse("forbidden origin", { status: 403 });
    }
  }

  const ok = await verifySessionValue(req.cookies.get(ADMIN_COOKIE)?.value, process.env.ADMIN_SESSION_SECRET);
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/admin", "/admin/:path*", "/api/admin/:path*", "/s/:path*"] };
