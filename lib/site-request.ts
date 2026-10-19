import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getStore } from "./store";
import type { MemberRow, TenantRow } from "./store/types";
import { getSessionMember, memberCookieName, SESSION_TTL_SECONDS } from "./services/members";
import { requestSiteBase, siteCookiePath } from "./site-url";
import { ServiceError } from "./errors";
import { baseUrlFrom } from "./runtime";

/**
 * 租戶網站（/s/<slug>/…）的表單 POST 共用工具。
 * 🔴 這些路由刻意放在 /s/<slug>/api/… 底下：會員 cookie 的 path 限定 /s/<slug>，放在 /api/… 收不到。
 */

/** POST 檢查 Origin（與後台 middleware 同一套）：沒帶 Origin 視為伺服器對伺服器呼叫 */
export function originOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return !origin;
  try {
    const o = new URL(origin);
    if (o.origin === new URL(req.url).origin) return true;
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return !!host && o.host === host;
  } catch {
    return false;
  }
}

/** 303 回到站內某頁並帶訊息（只接受站內路徑；租戶 host 上回到同一個 host，路徑模式回到 /s/<slug>） */
export function siteRedirect(req: Request, slug: string, path: string, msg?: { ok?: string; err?: string }, extra?: Record<string, string>) {
  const safe = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  const base = requestSiteBase(req.headers, slug, baseUrlFrom(req));
  const u = new URL(`${base}${safe === "/" ? (base.includes("/s/") ? "" : "/") : safe}`);
  if (msg?.ok) u.searchParams.set("ok", msg.ok.slice(0, 300));
  if (msg?.err) u.searchParams.set("err", msg.err.slice(0, 300));
  for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v);
  return NextResponse.redirect(u, 303);
}

/** 只接受站內相對路徑當 next 參數（防 open redirect） */
export function safeNext(v: unknown, fallback: string): string {
  return typeof v === "string" && /^\/(?!\/)[\w\-/.?=&%]*$/.test(v) && v.length < 300 ? v : fallback;
}

/**
 * 會員 session cookie：HttpOnly、SameSite=Lax、prod Secure，**不帶 Domain（host-only）**。
 * 租戶 host（子網域／自有網域）上 path 是 /；路徑模式 /s/<slug>（lib/site-url.ts siteCookiePath）。
 */
export function setMemberCookie(res: NextResponse, tenant: TenantRow, token: string, expires: Date, req: Request) {
  res.cookies.set(memberCookieName(tenant.id), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: siteCookiePath(req.headers, tenant.slug),
    expires,
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearMemberCookie(res: NextResponse, tenant: TenantRow, req: Request) {
  res.cookies.set(memberCookieName(tenant.id), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: siteCookiePath(req.headers, tenant.slug),
    maxAge: 0,
  });
}

/** route handler 用：直接讀 request 的 Cookie header（不依賴 next/headers 的 request scope） */
export function memberTokenFromRequest(req: Request, tenant: TenantRow): string | undefined {
  const name = memberCookieName(tenant.id);
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export async function memberTokenFromCookies(tenant: TenantRow): Promise<string | undefined> {
  return (await cookies()).get(memberCookieName(tenant.id))?.value;
}

/** server component／route 讀目前登入的會員（session 必須屬於這個網站） */
export async function currentMember(tenant: TenantRow): Promise<MemberRow | null> {
  const r = await getSessionMember(getStore(), tenant, await memberTokenFromCookies(tenant));
  return r?.member ?? null;
}

export function messageOf(e: unknown): string {
  if (e instanceof ServiceError) return e.message;
  console.error(e);
  return "伺服器錯誤，請稍後再試";
}

export async function formObject(req: Request): Promise<Record<string, string>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 50_000) throw new ServiceError("invalid", "內容太長");
  const f = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of f.entries()) if (typeof v === "string") out[k] = v;
  return out;
}
