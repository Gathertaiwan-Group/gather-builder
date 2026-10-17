import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, verifySessionValue } from "@/lib/adminAuth";

/** 擋 /admin 與 /api/admin（登入頁與登入 API 除外）；後台 POST 另外檢查 Origin 防 CSRF */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
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

export const config = { matcher: ["/admin", "/admin/:path*", "/api/admin/:path*"] };
