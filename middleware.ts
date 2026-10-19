import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, verifySessionValue } from "@/lib/adminAuth";
import { LANG_CODES } from "@/lib/i18n/langs";
import { decideRoute, hostConfigFromEnv, hostPort } from "@/lib/host-routing";
import { edgeRoutingLookup } from "@/lib/edge-routing";

const LANG_PATH = new RegExp(`^/s/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])/(${LANG_CODES.join("|")})(/.*)?$`);
/** 只能由 middleware 設定的內部 header；客戶端送來的一律刪掉 */
const INTERNAL_HEADERS = ["x-gb-lang", "x-gb-host-slug", "x-gb-origin", "x-gb-bo"];

/** /s/<slug>/<lang>/… → /s/<slug>/…＋x-gb-lang（站內 API 不改寫） */
function langRewrite(pathname: string, headers: Headers): string {
  const m = LANG_PATH.exec(pathname);
  if (m && !(m[3] ?? "").startsWith("/api")) {
    headers.set("x-gb-lang", m[2]!);
    return `/s/${m[1]}${m[3] ?? ""}`;
  }
  return pathname;
}

function sameOriginPost(req: NextRequest): boolean {
  if (req.method !== "POST") return true;
  const origin = req.headers.get("origin");
  if (!origin || origin === req.nextUrl.origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? req.nextUrl.host);
  } catch {
    return false;
  }
}

/**
 * 1. 依 Host 分流（lib/host-routing.ts）：租戶子網域／自有網域 → 改寫到 /s/<slug>/…，並設 x-gb-host-slug／x-gb-origin；
 *    平台專用路徑（/admin、/owner、/build、/oauth、/api…）在租戶 host 上 404。平台 host 照舊（啟用子網域後 /s/<slug> GET 301 到正式網址）。
 * 2. 租戶網站多語：/s/<slug>/<lang>/… → /s/<slug>/…＋x-gb-lang。
 * 3. 擋 /admin 與 /api/admin（登入頁與登入 API 除外）；後台 POST 檢查 Origin 防 CSRF。
 *    店主後台 /owner 與 /api/owner 由頁面／route 自己驗 session（DB session，可撤銷），這裡只做 Origin 檢查。
 */
export async function middleware(req: NextRequest) {
  const res = await route(req);
  // 第九批審查 L6：後台、店主後台、OAuth 同意頁不准被嵌入（防 clickjacking）
  if (/^\/(admin|owner|oauth|build\/orders)(\/|$)/.test(req.nextUrl.pathname)) {
    res.headers.set("content-security-policy", "frame-ancestors 'none'");
    res.headers.set("x-frame-options", "DENY");
  }
  return res;
}

async function route(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const headers = new Headers(req.headers);
  for (const h of INTERNAL_HEADERS) headers.delete(h);

  // 正式／本機伺服器一定有 Host；沒有時（單元測試直接建 NextRequest）退回 URL 的 host
  const host = req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.nextUrl.protocol.replace(":", "") || "https";
  const decision = await decideRoute(
    { host, pathname, search: req.nextUrl.search, method: req.method, proto, port: hostPort(host) },
    hostConfigFromEnv(),
    edgeRoutingLookup,
  );
  if (decision.type === "notfound") return new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (decision.type === "redirect") return NextResponse.redirect(decision.location, decision.status);
  if (decision.type === "rewrite") {
    headers.set("x-gb-host-slug", decision.slug);
    headers.set("x-gb-origin", decision.origin);
    const url = req.nextUrl.clone();
    url.pathname = langRewrite(decision.pathname, headers);
    return NextResponse.rewrite(url, { request: { headers } });
  }

  // ---- 平台 host
  if (pathname.startsWith("/s/")) {
    const rewritten = langRewrite(pathname, headers);
    if (rewritten !== pathname) {
      const url = req.nextUrl.clone();
      url.pathname = rewritten;
      return NextResponse.rewrite(url, { request: { headers } });
    }
    return NextResponse.next({ request: { headers } });
  }

  const isAdminPath = pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/");
  const isOwnerPath = pathname === "/owner" || pathname.startsWith("/owner/") || pathname.startsWith("/api/owner/");
  if (isOwnerPath) {
    headers.set("x-gb-bo", "owner");
    if (!sameOriginPost(req)) return new NextResponse("forbidden origin", { status: 403 });
    return NextResponse.next({ request: { headers } });
  }
  if (!isAdminPath) return NextResponse.next({ request: { headers } });

  headers.set("x-gb-bo", "admin");
  if (pathname === "/admin/login" || pathname === "/api/admin/login") return NextResponse.next({ request: { headers } });
  if (!sameOriginPost(req)) return new NextResponse("forbidden origin", { status: 403 });

  const ok = await verifySessionValue(req.cookies.get(ADMIN_COOKIE)?.value, process.env.ADMIN_SESSION_SECRET);
  if (ok) return NextResponse.next({ request: { headers } });
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
