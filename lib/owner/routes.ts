import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getStore } from "../store";
import { getMailer } from "../mail";
import { requireSecret } from "../secrets";
import { baseUrlFrom } from "../runtime";
import { clientIp } from "../client-ip";
import { ServiceError } from "../errors";
import { formObject } from "../site-request";
import { FLASH_COOKIE } from "../adminServer";
import {
  OWNER_COOKIE,
  OWNER_MFA_COOKIE,
  OWNER_SESSION_ABSOLUTE_MS,
  MFA_TTL_MS,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  getOwnerSession,
  ownerAcceptInvite,
  ownerForgotPassword,
  ownerLogin,
  ownerLogout,
  ownerResetPassword,
  ownerVerifyMfa,
  type OwnerDeps,
} from "../services/owners";

/** 店主後台登入相關的 route handler 實作（app/api/owner/* 只是轉呼叫） */
const secure = () => process.env.NODE_ENV === "production";

export function ownerDeps(req: Request): OwnerDeps {
  return { store: getStore(), ipSecret: requireSecret("PREVIEW_SECRET"), baseUrl: baseUrlFrom(req), sendMail: getMailer() };
}

/** 只接受 /owner 底下的站內路徑，或 OAuth 授權頁 /oauth/authorize?…（防 open redirect） */
export function safeOwnerNext(v: unknown): string {
  if (typeof v !== "string" || v.startsWith("//")) return "/owner";
  if (/^\/owner(\/[\w\-/.?=&%]*)?$/.test(v) && v.length < 300) return v;
  if (/^\/oauth\/authorize\?[\w\-.~%=&+:/]*$/.test(v) && v.length < 4000) return v;
  return "/owner";
}

function to(req: Request, path: string, msg?: { ok?: string; err?: string }) {
  const u = new URL(path, baseUrlFrom(req));
  if (msg?.ok) u.searchParams.set("ok", msg.ok.slice(0, 300));
  if (msg?.err) u.searchParams.set("err", msg.err.slice(0, 300));
  return NextResponse.redirect(u, 303);
}

const errText = (e: unknown) => {
  if (e instanceof ServiceError) return e.message;
  console.error(e);
  return "伺服器錯誤，請稍後再試";
};

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function setSession(res: NextResponse, token: string, expiresAt: Date) {
  // 🔴 host-only（不帶 Domain）：只在平台 host，租戶子網域收不到
  res.cookies.set(OWNER_COOKIE, token, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", expires: expiresAt, maxAge: Math.floor(OWNER_SESSION_ABSOLUTE_MS / 1000) });
  res.cookies.set(OWNER_MFA_COOKIE, "", { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 0 });
}

export async function handleOwnerLogin(req: Request) {
  let next = "/owner";
  try {
    const f = await formObject(req);
    next = safeOwnerNext(f.next);
    const r = await ownerLogin(ownerDeps(req), { email: f.email, password: f.password, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    if (r.kind === "mfa") {
      const res = to(req, `/owner/mfa?next=${encodeURIComponent(next)}`);
      res.cookies.set(OWNER_MFA_COOKIE, r.ticket, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: Math.floor(MFA_TTL_MS / 1000) });
      return res;
    }
    const res = to(req, next);
    setSession(res, r.token, r.expiresAt);
    return res;
  } catch (e) {
    return to(req, `/owner/login?next=${encodeURIComponent(next)}`, { err: errText(e) });
  }
}

export async function handleOwnerMfa(req: Request) {
  let next = "/owner";
  try {
    const f = await formObject(req);
    next = safeOwnerNext(f.next);
    const r = await ownerVerifyMfa(ownerDeps(req), { ticket: readCookie(req, OWNER_MFA_COOKIE), code: f.code, ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    const res = to(req, next);
    setSession(res, r.token, r.expiresAt);
    return res;
  } catch (e) {
    const msg = errText(e);
    return to(req, /逾時/.test(msg) ? `/owner/login?next=${encodeURIComponent(next)}` : `/owner/mfa?next=${encodeURIComponent(next)}`, { err: msg });
  }
}

export async function handleOwnerLogout(req: Request) {
  await ownerLogout(getStore(), readCookie(req, OWNER_COOKIE)).catch(() => undefined);
  const res = to(req, "/owner/login", { ok: "已登出" });
  res.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}

export async function handleOwnerForgot(req: Request) {
  const started = Date.now();
  try {
    const f = await formObject(req);
    const r = await ownerForgotPassword(ownerDeps(req), { email: f.email, ip: clientIp(req) });
    // 回應時間不洩漏帳號是否存在
    const wait = 400 - (Date.now() - started);
    if (wait > 0) await new Promise((x) => setTimeout(x, wait));
    return to(req, "/owner/login", { ok: r.message });
  } catch (e) {
    return to(req, "/owner/forgot", { err: errText(e) });
  }
}

export async function handleOwnerReset(req: Request) {
  let t = "";
  try {
    const f = await formObject(req);
    t = f.token ?? "";
    const r = await ownerResetPassword(ownerDeps(req), { token: f.token, password: f.password, ip: clientIp(req) });
    const res = to(req, "/owner/login", { ok: r.message });
    res.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    return to(req, `/owner/reset?t=${encodeURIComponent(t)}`, { err: errText(e) });
  }
}

export async function handleOwnerInvite(req: Request) {
  let t = "";
  try {
    const f = await formObject(req);
    t = f.token ?? "";
    const r = await ownerAcceptInvite(ownerDeps(req), { token: f.token, password: f.password, name: f.name, ip: clientIp(req) });
    return to(req, "/owner/login", { ok: r.message });
  } catch (e) {
    return to(req, `/owner/invite?t=${encodeURIComponent(t)}`, { err: errText(e) });
  }
}

/** 帳號：TOTP 啟用／停用、登出所有裝置（需登入） */
export async function handleOwnerAccount(req: Request) {
  const store = getStore();
  const s = await getOwnerSession(store, readCookie(req, OWNER_COOKIE));
  if (!s) return to(req, "/owner/login?next=/owner/account");
  try {
    const f = await formObject(req);
    if (f.action === "totp_begin") {
      await beginTotpSetup(store, s.user, f.password);
      return to(req, "/owner/account", { ok: "請用驗證器 App 掃描或輸入金鑰，再輸入 6 位數驗證碼完成啟用" });
    }
    if (f.action === "totp_confirm") {
      const r = await confirmTotpSetup(store, s.user, f.code ?? "", f.password);
      const res = to(req, "/owner/account", { ok: "已啟用二步驟驗證。請立刻把下面的復原碼存到安全的地方（只顯示這一次）" });
      // 復原碼只顯示一次：短效 httpOnly cookie（path /owner），不放網址
      res.cookies.set(FLASH_COOKIE, r.recoveryCodes.join(" "), { httpOnly: true, secure: secure(), sameSite: "strict", path: "/owner", maxAge: 120 });
      return res;
    }
    if (f.action === "totp_disable") {
      await disableTotp(store, s.user, f.code ?? "", f.password);
      return to(req, "/owner/account", { ok: "已停用二步驟驗證" });
    }
    if (f.action === "revoke_grant") {
      const g = await store.getOAuthGrant(f.grantId ?? "");
      // 只能撤銷自己同意過的授權（任何角色都可以）
      if (!g || g.user_id !== s.user.id) throw new ServiceError("not_found", "找不到這個授權");
      await store.revokeOAuthGrant(g.id, "revoked_by_user");
      await store.insertAudit({ tenant_id: g.tenant_id, actor: `owner:${s.user.email}`, action: "oauth.revoke", payload: { grantId: g.id, by: "self" } });
      return to(req, "/owner/account", { ok: "已撤銷這個 AI agent 授權" });
    }
    if (f.action === "logout_all") {
      const n = await store.revokeOwnerSessionsForUser(s.user.id);
      // 第九批審查 M3：登出所有裝置也撤銷這個帳號同意過的所有 OAuth 授權
      const g = await store.revokeOAuthGrantsForUser(s.user.id, "logout_all");
      await store.insertAudit({ tenant_id: null, actor: `owner:${s.user.email}`, action: "owner.logout_all", payload: { sessions: n, oauthGrants: g } });
      const res = to(req, "/owner/login", { ok: `已登出所有裝置（${n} 個 session、${g} 個 AI agent 授權）` });
      res.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 0 });
      return res;
    }
    throw new ServiceError("invalid", "未知動作");
  } catch (e) {
    return to(req, "/owner/account", { err: errText(e) });
  }
}

/** server component：目前登入的店主（沒登入回 null） */
export async function currentOwnerSession() {
  return getOwnerSession(getStore(), (await cookies()).get(OWNER_COOKIE)?.value);
}
