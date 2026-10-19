import { NextResponse, after } from "next/server";
import { getStore } from "./store";
import { requireSecret } from "./secrets";
import { getMailer } from "./mail";
import { baseUrlFrom } from "./runtime";
import { clientIp } from "./client-ip";
import {
  getSessionMember,
  loadMemberTenant,
  loginMember,
  logoutMember,
  registerMember,
  requestPasswordReset,
  resetPassword,
  updateOwnProfile,
  type MemberDeps,
} from "./services/members";
import { clearMemberCookie, formObject, memberTokenFromRequest, messageOf, originOk, safeNext, setMemberCookie, siteRedirect } from "./site-request";
import type { Store } from "./store/types";

/**
 * 會員表單 POST 的處理（app/s/[site]/api/account/* 只是轉呼叫這裡）。
 * 一律 303 回到頁面並帶 ok/err 訊息；錯誤訊息不洩漏帳號是否存在。
 */
export type MemberAction = "login" | "register" | "logout" | "forgot" | "reset" | "profile";

export async function handleMemberPost(req: Request, rawSlug: string, action: MemberAction, store: Store = getStore()): Promise<Response> {
  const slug = rawSlug.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  let tenant;
  try {
    tenant = await loadMemberTenant(store, slug);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
  const deps: MemberDeps = { store, ipSecret: requireSecret("PREVIEW_SECRET"), baseUrl: baseUrlFrom(req), sendMail: getMailer(), defer: (t) => after(() => t) };
  const ip = clientIp(req);
  const back: Record<MemberAction, string> = { login: "/account/login", register: "/account/register", logout: "/account/login", forgot: "/account/forgot", reset: "/account/reset", profile: "/account" };
  let form: Record<string, string> = {};
  try {
    form = await formObject(req);
    switch (action) {
      case "register": {
        const r = await registerMember(deps, { tenant, ip, data: form });
        return siteRedirect(req, slug, "/account/login", { ok: r.message });
      }
      case "login": {
        const r = await loginMember(deps, { tenant, ip, ua: req.headers.get("user-agent"), email: form.email, password: form.password });
        const res = siteRedirect(req, slug, safeNext(form.next, "/account"));
        setMemberCookie(res, tenant, r.token, r.expiresAt, req);
        return res;
      }
      case "logout": {
        await logoutMember(store, tenant, memberTokenFromRequest(req, tenant));
        const res = siteRedirect(req, slug, "/account/login", { ok: "已登出" });
        clearMemberCookie(res, tenant, req);
        return res;
      }
      case "forgot": {
        const r = await requestPasswordReset(deps, { tenant, ip, email: form.email });
        return siteRedirect(req, slug, "/account/forgot", { ok: r.message });
      }
      case "reset": {
        const r = await resetPassword(deps, { tenant, ip, token: form.token, password: form.password });
        const res = siteRedirect(req, slug, "/account/login", { ok: r.message });
        clearMemberCookie(res, tenant, req);
        return res;
      }
      case "profile": {
        const cur = await getSessionMember(store, tenant, memberTokenFromRequest(req, tenant));
        if (!cur) return siteRedirect(req, slug, "/account/login", { err: "請先登入" });
        await updateOwnProfile(store, tenant, cur.member, form);
        return siteRedirect(req, slug, "/account", { ok: "已儲存" });
      }
    }
  } catch (e) {
    // reset 失敗回到 reset 頁時保留 token（密碼太短可以重填）；token 無效時不保留
    const extra = action === "reset" && form.token && !/連結無效/.test(messageOf(e)) ? { token: form.token } : undefined;
    return siteRedirect(req, slug, back[action], { err: messageOf(e) }, extra);
  }
}
