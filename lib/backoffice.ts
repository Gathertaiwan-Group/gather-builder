import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { ADMIN_COOKIE, verifySessionValue } from "./adminAuth";
import { adminActor, type Actor } from "./tokens";
import { makeContext } from "./runtime";
import { getStore } from "./store";
import type { OwnerUserRow, TenantRow } from "./store/types";
import { OWNER_COOKIE, getOwnerSession, ownerActor, VIEWER_SCOPES } from "./services/owners";
import { ServiceError, type ServiceContext } from "./services/context";
import { FLASH_COOKIE } from "./adminServer";

/**
 * 網站後台頁面的共用身分層：同一套頁面與 API 掛在兩個入口——
 * - 平台擁有者後台 /admin/t/<slug>（HMAC cookie，admin actor，全部 scope）
 * - 店主後台 /owner/t/<slug>（DB session，owner actor，依角色給 scope；跨租戶一律 404）
 * 入口由 middleware 依路徑設定的 x-gb-bo header 決定（客戶端送來的會被刪掉）。
 * 平台擁有者帶 admin cookie 進 /owner/t/<slug>（沒有店主 session）＝「以店主身分檢視」：viewer 權限＋稽核。
 */
export interface Backoffice {
  mode: "admin" | "owner";
  tenant: TenantRow;
  slug: string;
  ctx: ServiceContext;
  /** 頁面前綴：/admin/t/<slug> 或 /owner/t/<slug> */
  base: string;
  /** API 前綴：/api/admin/tenants/<slug> 或 /api/owner/tenants/<slug> */
  api: string;
  role: "admin" | "owner" | "editor" | "viewer";
  /** 平台擁有者以店主身分檢視（唯讀） */
  viewAs: boolean;
  user: OwnerUserRow | null;
}

type Resolved = { ok: true; bo: Backoffice } | { ok: false; reason: "login" | "notfound" };

async function resolve(slug: string, h: Headers, cookie: (n: string) => string | undefined, req?: { headers: Headers } | null): Promise<Resolved> {
  const store = getStore();
  const mode = h.get("x-gb-bo") === "owner" ? "owner" : "admin";
  const isAdmin = await verifySessionValue(cookie(ADMIN_COOKIE), process.env.ADMIN_SESSION_SECRET);
  const tenant = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) ? await store.getTenantBySlug(slug) : null;
  const shape = (actor: Actor, role: Backoffice["role"], viewAs: boolean, user: OwnerUserRow | null): Backoffice => ({
    mode,
    tenant: tenant!,
    slug,
    ctx: makeContext(actor, req ?? { headers: h }, store),
    base: mode === "admin" ? `/admin/t/${slug}` : `/owner/t/${slug}`,
    api: mode === "admin" ? `/api/admin/tenants/${slug}` : `/api/owner/tenants/${slug}`,
    role,
    viewAs,
    user,
  });
  if (mode === "admin") {
    if (!isAdmin) return { ok: false, reason: "login" };
    if (!tenant) return { ok: false, reason: "notfound" };
    return { ok: true, bo: shape(adminActor(), "admin", false, null) };
  }
  const s = await getOwnerSession(store, cookie(OWNER_COOKIE));
  if (s) {
    const m = tenant ? await store.getTenantUser(tenant.id, s.user.id) : null;
    // 🔴 跨租戶：不是這個網站的啟用中成員 → 404（不洩漏網站是否存在）
    if (!tenant || !m || m.status !== "active") return isAdmin && tenant ? { ok: true, bo: viewAsAdmin() } : { ok: false, reason: "notfound" };
    return { ok: true, bo: shape(ownerActor(s.user, m), m.role, false, s.user) };
  }
  if (isAdmin && tenant) return { ok: true, bo: viewAsAdmin() };
  return { ok: false, reason: "login" };

  function viewAsAdmin(): Backoffice {
    const actor: Actor = { kind: "owner", label: "admin(以店主身分檢視)", tenantId: tenant!.id, scopes: VIEWER_SCOPES, role: "viewer" };
    return shape(actor, "viewer", true, null);
  }
}

/** 頁面用：沒登入導到登入頁，沒權限 404 */
export async function requireBackoffice(slug: string): Promise<Backoffice> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const r = await resolve(slug, new Headers(h), (n) => c.get(n)?.value);
  if (!r.ok) {
    if (r.reason === "notfound") notFound();
    redirect(h.get("x-gb-bo") === "owner" ? `/owner/login?next=${encodeURIComponent(`/owner/t/${slug}`)}` : "/admin/login");
  }
  if (r.bo.viewAs) await r.bo.ctx.store.insertAudit({ tenant_id: r.bo.tenant.id, actor: "admin", action: "admin.view_as_owner", payload: {} }).catch(() => undefined);
  return r.bo;
}

function cookieFrom(req: Request) {
  return (name: string) => {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return undefined;
  };
}

/** API route 用（GET 下載等）：沒有身分回 null */
export async function backofficeForRequest(req: Request, slug: string): Promise<Backoffice | null> {
  const r = await resolve(slug, req.headers, cookieFrom(req), req);
  if (!r.ok) return null;
  // 第九批審查 L15：「以店主身分檢視」的 API 存取（含 GET 下載名單）也寫稽核
  if (r.bo.viewAs) await r.bo.ctx.store.insertAudit({ tenant_id: r.bo.tenant.id, actor: "admin", action: "admin.view_as_owner", payload: { method: req.method, path: new URL(req.url).pathname } }).catch(() => undefined);
  return r.bo;
}

/**
 * 後台表單 POST 的共用處理（取代 adminForm，兩個入口共用）：驗證身分 → 以角色 actor 執行服務函式 → 303 回頁面帶訊息。
 * 「以店主身分檢視」一律拒絕寫入。CSRF（Origin）在 middleware。
 */
export async function backofficeForm(
  req: Request,
  slug: string,
  backSuffix: string,
  fn: (form: FormData, bo: Backoffice) => Promise<{ message: string; flashToken?: string; redirectTo?: string }>,
): Promise<Response> {
  const bo = await backofficeForRequest(req, slug);
  if (!bo) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const back = `${bo.base}${backSuffix}`;
  const form = await req.formData();
  const target = (path: string, key: "ok" | "err", msg: string) => {
    const u = new URL(path, req.url);
    u.searchParams.set(key, msg.slice(0, 300));
    return u;
  };
  try {
    if (bo.viewAs) throw new ServiceError("forbidden", "以店主身分檢視是唯讀的");
    const r = await fn(form, bo);
    const res = NextResponse.redirect(target(r.redirectTo ?? back, "ok", r.message), 303);
    if (r.flashToken) {
      res.cookies.set(FLASH_COOKIE, r.flashToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: bo.mode === "admin" ? "/admin" : "/owner", maxAge: 120 });
    }
    return res;
  } catch (e) {
    const msg = e instanceof ServiceError ? e.message : "伺服器錯誤";
    if (!(e instanceof ServiceError)) console.error(e);
    return NextResponse.redirect(target(back, "err", msg), 303);
  }
}
