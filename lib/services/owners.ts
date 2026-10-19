import { createHash, randomBytes } from "node:crypto";
import { logUnsentMail } from "../mail";
import { z } from "zod";
import type { Mailer } from "../mail";
import { burnPasswordCheck, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, verifyPassword } from "../members/password";
import { decryptSecret, encryptSecret } from "../secretbox";
import { TENANT_SCOPES, type Scope } from "../scopes";
import { generateToken, type Actor } from "../tokens";
import { newTotpSecret, otpauthUri, verifyTotp } from "../owner/totp";
import type { OwnerUserRow, Store, TenantRole, TenantRow, TenantUserRow } from "../store/types";
import { ServiceError, audit, requireScope, resolveTenant, type ServiceContext } from "./context";
import { hashIp } from "./inquiries";

/**
 * 店主後台（第九批）：平台自管帳號（不用 Supabase Auth）。
 * - 帳號 builder_owner_users（一個 email 一個帳號，可屬於多個網站）＋成員 builder_tenant_users（角色 owner／editor／viewer、邀請制、可停用）。
 * - 密碼 scrypt（同會員）；session 只存 sha256、可撤銷、登出撤銷、閒置 12 小時與絕對 7 天到期；重設密碼撤銷全部 session。
 * - 可選 TOTP 二步驟（任何角色都可以啟用）：密碼對了先發 5 分鐘的 mfa ticket，輸入 6 位數碼才建 session；同一組碼只能用一次。
 * - 權限：viewer 只有讀取 scope；editor 有所有網站 scope 但不能改金流／發票／物流憑證、網域、成員、MCP token；owner 全部。
 *   寫入一律走既有 lib/services（requireScope／requireFormCredential），跨租戶由 resolveTenant 擋。
 */
export const OWNER_COOKIE = "gb_owner";
export const OWNER_MFA_COOKIE = "gb_owner_mfa";
export const OWNER_SESSION_ABSOLUTE_MS = 7 * 86400_000;
export const OWNER_SESSION_IDLE_MS = 12 * 3600_000;
const TOUCH_EVERY_MS = 5 * 60_000;
export const INVITE_TTL_MS = 7 * 86400_000;
export const RESET_TTL_MS = 3600_000;
export const MFA_TTL_MS = 5 * 60_000;

export const OWNER_RATE = {
  loginIp: { limit: 30, window: 15 * 60 },
  loginEmailIp: { limit: 10, window: 15 * 60 },
  /** 第九批審查 L9：只看 email（跨 IP）：每小時 20 次，超過只延遲、不鎖死（避免被拿來鎖住特定店主） */
  loginEmail: { limit: 20, window: 3600 },
  mfaTicket: { limit: 5, window: 5 * 60 },
  forgotIp: { limit: 5, window: 3600 },
  forgotEmail: { limit: 3, window: 3600 },
  tokenIp: { limit: 20, window: 3600 },
} as const;

export const OWNER_LOGIN_FAILED = "Email 或密碼錯誤";
export const OWNER_FORGOT_DONE = "如果這個 Email 有店主帳號，我們已寄出重設密碼連結（1 小時內有效）。";
export const OWNER_TOKEN_INVALID = "連結無效或已過期，請重新申請。";

export const VIEWER_SCOPES: Scope[] = ["site:read", "inquiries:read", "members:read", "orders:read", "newsletter:read", "attendees:read", "certificates:read"];

export function scopesForRole(role: TenantRole): Scope[] {
  return role === "viewer" ? VIEWER_SCOPES : TENANT_SCOPES;
}

export function ownerActor(user: Pick<OwnerUserRow, "id" | "email">, m: Pick<TenantUserRow, "tenant_id" | "role">, labelSuffix = ""): Actor {
  return { kind: "owner", label: `owner:${user.email}${labelSuffix}`, tenantId: m.tenant_id, scopes: scopesForRole(m.role), role: m.role, userId: user.id };
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const rawToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email({ message: "Email 格式不正確" }));
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, { message: `密碼至少 ${MIN_PASSWORD_LENGTH} 碼` }).max(MAX_PASSWORD_LENGTH, { message: "密碼太長" });
const parseOr = <T extends z.ZodType>(s: T, v: unknown): z.output<T> => {
  const r = s.safeParse(v);
  if (!r.success) throw new ServiceError("invalid", r.error.issues.map((i) => i.message).join("；"));
  return r.data;
};

export const OWNER_LOGIN_SLOWDOWN_MS = 1500;

export interface OwnerDeps {
  store: Store;
  /** IP 雜湊金鑰（PREVIEW_SECRET） */
  ipSecret: string;
  /** 平台網址（店主後台在平台 host） */
  baseUrl: string;
  sendMail?: Mailer;
  /** 測試用：覆寫超過 email 門檻時的延遲 */
  slowdownMs?: number;
}

async function limit(deps: OwnerDeps, bucket: string, key: string, rule: { limit: number; window: number }) {
  const hit = await deps.store.rateHit(bucket, key, rule.window, rule.limit);
  if (!hit.allowed) throw new ServiceError("rate_limited", "嘗試太多次，請稍後再試");
}

async function deliver(deps: OwnerDeps, to: string, subject: string, text: string) {
  if (!deps.sendMail) {
    logUnsentMail("owners", to, subject, text);
    return;
  }
  try {
    await deps.sendMail(to, subject, text);
  } catch (e) {
    console.error("[owners] 寄信失敗", e instanceof Error ? e.message : e);
  }
}

/* ------------------------------------------------------------------ session */

async function createSession(deps: OwnerDeps, user: OwnerUserRow, ip: string, ua: string | null) {
  const token = rawToken("gbs");
  const expiresAt = new Date(Date.now() + OWNER_SESSION_ABSOLUTE_MS);
  await deps.store.insertOwnerSession({ user_id: user.id, token_hash: sha256(token), ip_hash: hashIp(ip, deps.ipSecret), user_agent: ua?.slice(0, 300) ?? null, expires_at: expiresAt.toISOString() });
  await deps.store.updateOwnerUser(user.id, { last_login_at: new Date().toISOString() });
  return { kind: "session" as const, token, expiresAt, userId: user.id };
}

/** 讀 session：撤銷、絕對到期、閒置到期（到期當下撤銷）、帳號停用一律 null；每 5 分鐘更新一次 last_seen_at */
export async function getOwnerSession(store: Store, raw: string | undefined | null, nowMs = Date.now()) {
  if (!raw || !/^gbs_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const s = await store.getOwnerSessionByHash(sha256(raw));
  if (!s || s.revoked_at || Date.parse(s.expires_at) <= nowMs) return null;
  if (Date.parse(s.last_seen_at) + OWNER_SESSION_IDLE_MS <= nowMs) {
    await store.revokeOwnerSession(s.id);
    return null;
  }
  const user = await store.getOwnerUserById(s.user_id);
  if (!user || user.status !== "active") return null;
  if (Date.parse(s.last_seen_at) + TOUCH_EVERY_MS <= nowMs) await store.touchOwnerSession(s.id, new Date(nowMs).toISOString()).catch(() => undefined);
  return { session: s, user };
}

export async function ownerLogout(store: Store, raw: string | undefined | null) {
  if (!raw) return;
  const s = await store.getOwnerSessionByHash(sha256(raw));
  if (s) await store.revokeOwnerSession(s.id);
}

/* ------------------------------------------------------------------ 登入／二步驟 */

export async function ownerLogin(deps: OwnerDeps, input: { email: unknown; password: unknown; ip: string; userAgent?: string | null }) {
  const ipKey = hashIp(input.ip, deps.ipSecret);
  await limit(deps, "owner-login-ip", ipKey, OWNER_RATE.loginIp);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase().slice(0, 254) : "";
  const password = typeof input.password === "string" ? input.password.slice(0, MAX_PASSWORD_LENGTH) : "";
  await limit(deps, "owner-login-email-ip", `${sha256(email).slice(0, 32)}:${ipKey}`, OWNER_RATE.loginEmailIp);
  if (email && !(await deps.store.rateHit("owner-login-email", sha256(email).slice(0, 32), OWNER_RATE.loginEmail.window, OWNER_RATE.loginEmail.limit)).allowed) {
    await new Promise((r) => setTimeout(r, deps.slowdownMs ?? OWNER_LOGIN_SLOWDOWN_MS));
  }
  const user = email ? await deps.store.getOwnerUserByEmail(email) : null;
  if (!user?.password_hash) {
    await burnPasswordCheck(password);
    throw new ServiceError("unauthorized", OWNER_LOGIN_FAILED);
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok || user.status !== "active") throw new ServiceError("unauthorized", OWNER_LOGIN_FAILED);
  if (user.totp_enabled_at && user.totp_secret_enc) {
    const ticket = rawToken("gbm");
    await deps.store.insertOwnerToken({ user_id: user.id, tenant_id: null, purpose: "mfa", token_hash: sha256(ticket), expires_at: new Date(Date.now() + MFA_TTL_MS).toISOString() });
    return { kind: "mfa" as const, ticket };
  }
  return createSession(deps, user, input.ip, input.userAgent ?? null);
}

/** 二步驟：ticket（cookie）＋ 6 位數碼。輸錯不讓 ticket 失效（每張 ticket 最多試 5 次）；成功才消耗 ticket、記錄時間步（防重放） */
export async function ownerVerifyMfa(deps: OwnerDeps, input: { ticket: string | undefined; code: unknown; ip: string; userAgent?: string | null }) {
  const nowIso = new Date().toISOString();
  if (!input.ticket || !/^gbm_[A-Za-z0-9_-]{43}$/.test(input.ticket)) throw new ServiceError("unauthorized", "登入逾時，請重新輸入密碼");
  const hash = sha256(input.ticket);
  await limit(deps, "owner-mfa", hash.slice(0, 32), OWNER_RATE.mfaTicket);
  const t = await deps.store.peekOwnerToken(hash, "mfa", nowIso);
  if (!t) throw new ServiceError("unauthorized", "登入逾時，請重新輸入密碼");
  const user = await deps.store.getOwnerUserById(t.user_id);
  if (!user || user.status !== "active" || !user.totp_secret_enc) throw new ServiceError("unauthorized", "登入逾時，請重新輸入密碼");
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (RECOVERY_RE.test(code)) {
    // 第九批審查 L7：一次性復原碼（用掉就失效）
    if (!(await deps.store.useOwnerRecoveryCode(user.id, sha256(code.toLowerCase())))) throw new ServiceError("unauthorized", "驗證碼錯誤或已使用過");
    await deps.store.insertAudit({ tenant_id: null, actor: `owner:${user.email}`, action: "owner.totp_recovery_used", payload: { left: Math.max(0, user.totp_recovery_hashes.length - 1) } });
  } else {
    const step = verifyTotp(decryptSecret(user.totp_secret_enc, `owner-totp:${user.id}`), code);
    if (step === null || !(await deps.store.claimTotpStep(user.id, step))) throw new ServiceError("unauthorized", "驗證碼錯誤或已使用過");
  }
  if (!(await deps.store.consumeOwnerToken(hash, "mfa", nowIso))) throw new ServiceError("unauthorized", "登入逾時，請重新輸入密碼");
  return createSession(deps, user, input.ip, input.userAgent ?? null);
}

/* ------------------------------------------------------------------ 忘記密碼／重設／邀請 */

export async function ownerForgotPassword(deps: OwnerDeps, input: { email: unknown; ip: string }) {
  await limit(deps, "owner-forgot-ip", hashIp(input.ip, deps.ipSecret), OWNER_RATE.forgotIp);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase().slice(0, 254) : "";
  if (!email) return { message: OWNER_FORGOT_DONE };
  await limit(deps, "owner-forgot-email", sha256(email).slice(0, 32), OWNER_RATE.forgotEmail);
  const user = await deps.store.getOwnerUserByEmail(email);
  if (user && user.status === "active" && user.password_hash) {
    const raw = rawToken("gbr");
    await deps.store.invalidateOwnerTokens(user.id, "reset");
    await deps.store.insertOwnerToken({ user_id: user.id, tenant_id: null, purpose: "reset", token_hash: sha256(raw), expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString() });
    await deliver(deps, user.email, "【Gather Builder】重設店主後台密碼", `你好，\n\n請在 1 小時內點下列連結設定新密碼：\n${deps.baseUrl.replace(/\/$/, "")}/owner/reset?t=${encodeURIComponent(raw)}\n\n如果不是你本人申請，請忽略這封信。`);
  }
  return { message: OWNER_FORGOT_DONE };
}

export async function ownerResetPassword(deps: OwnerDeps, input: { token: unknown; password: unknown; ip: string }) {
  await limit(deps, "owner-token-ip", hashIp(input.ip, deps.ipSecret), OWNER_RATE.tokenIp);
  const password = parseOr(passwordSchema, input.password);
  const raw = typeof input.token === "string" ? input.token : "";
  const t = await deps.store.consumeOwnerToken(sha256(raw), "reset", new Date().toISOString());
  if (!t) throw new ServiceError("invalid", OWNER_TOKEN_INVALID);
  await deps.store.updateOwnerUser(t.user_id, { password_hash: await hashPassword(password) });
  const revoked = await deps.store.revokeOwnerSessionsForUser(t.user_id);
  // 第九批審查 M3：重設密碼＝帳號可能外洩 → 這個帳號同意過的 OAuth 授權（access／refresh token）一併撤銷
  const grants = await deps.store.revokeOAuthGrantsForUser(t.user_id, "password_reset");
  await deps.store.insertAudit({ tenant_id: null, actor: `owner-user:${t.user_id}`, action: "owner.password_reset", payload: { revokedSessions: revoked, revokedOAuthGrants: grants } });
  return { message: "密碼已更新，所有裝置與 AI agent 授權都已登出，請重新登入。" };
}

/** 接受邀請：設定密碼（帳號還沒有密碼時必填）→ 這個網站的成員 invited → active */
export async function ownerAcceptInvite(deps: OwnerDeps, input: { token: unknown; password: unknown; name?: unknown; ip: string }) {
  await limit(deps, "owner-token-ip", hashIp(input.ip, deps.ipSecret), OWNER_RATE.tokenIp);
  const raw = typeof input.token === "string" ? input.token : "";
  const peek = await deps.store.peekOwnerToken(sha256(raw), "invite", new Date().toISOString());
  if (!peek || !peek.tenant_id) throw new ServiceError("invalid", OWNER_TOKEN_INVALID);
  const user = await deps.store.getOwnerUserById(peek.user_id);
  if (!user || user.status !== "active") throw new ServiceError("invalid", OWNER_TOKEN_INVALID);
  const needsPassword = !user.password_hash;
  const password = needsPassword ? parseOr(passwordSchema, input.password) : null;
  const t = await deps.store.consumeOwnerToken(sha256(raw), "invite", new Date().toISOString());
  if (!t) throw new ServiceError("invalid", OWNER_TOKEN_INVALID);
  if (password) await deps.store.updateOwnerUser(user.id, { password_hash: await hashPassword(password), name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : user.name });
  const m = await deps.store.getTenantUser(t.tenant_id!, user.id);
  if (!m || m.status === "disabled") throw new ServiceError("invalid", "這個邀請已被撤銷");
  if (m.status === "invited") await deps.store.updateTenantUser(t.tenant_id!, m.id, { status: "active" });
  await deps.store.insertAudit({ tenant_id: t.tenant_id, actor: `owner:${user.email}`, action: "owner.invite_accept", payload: { role: m.role } });
  return { email: user.email, passwordSet: needsPassword, message: needsPassword ? "密碼已設定，請登入店主後台。" : "已加入網站，請用原本的密碼登入。" };
}

/**
 * 邀請（內部共用：店主後台成員管理、自動開站）：帳號不存在就建（沒有密碼）→ 成員 invited（已停用的改回 invited）→ 寄設定密碼連結（7 天）。
 * 回傳 inviteUrl 只給呼叫端寫 log／測試用，🔴 不要回給 agent 或顯示在頁面。
 */
export async function inviteOwnerInternal(deps: OwnerDeps, tenant: TenantRow, input: { email: string; role: TenantRole; by: string; name?: string | null }) {
  const email = parseOr(emailSchema, input.email);
  let user = await deps.store.getOwnerUserByEmail(email);
  if (!user) {
    try {
      user = await deps.store.insertOwnerUser({ email, name: input.name ?? null, password_hash: null });
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === "conflict")) throw e;
      user = (await deps.store.getOwnerUserByEmail(email))!;
    }
  }
  let m = await deps.store.getTenantUser(tenant.id, user.id);
  if (!m) {
    try {
      m = await deps.store.insertTenantUser({ tenant_id: tenant.id, user_id: user.id, role: input.role, status: "invited", invited_by: input.by });
    } catch (e) {
      if (!(e instanceof ServiceError && e.code === "conflict")) throw e;
      m = (await deps.store.getTenantUser(tenant.id, user.id))!;
    }
  } else if (m.status === "disabled" || m.role !== input.role) {
    // 第九批審查 L8：重新邀請改角色也要保留至少一位啟用中的 owner
    if (m.role === "owner" && m.status === "active" && input.role !== "owner" && (await deps.store.listTenantUsers(tenant.id)).filter((x) => x.role === "owner" && x.status === "active").length <= 1) {
      throw new ServiceError("invalid", "網站至少要有一位啟用中的擁有者（owner）");
    }
    m = (await deps.store.updateTenantUser(tenant.id, m.id, { role: input.role, ...(m.status === "disabled" ? { status: "invited" as const } : {}) }))!;
  }
  const raw = rawToken("gbi");
  await deps.store.insertOwnerToken({ user_id: user.id, tenant_id: tenant.id, purpose: "invite", token_hash: sha256(raw), expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString() });
  const inviteUrl = `${deps.baseUrl.replace(/\/$/, "")}/owner/invite?t=${encodeURIComponent(raw)}`;
  const roleText = { owner: "擁有者", editor: "編輯", viewer: "檢視者" }[input.role];
  await deliver(deps, email, `【Gather Builder】邀請你管理網站「${tenant.name}」`, `你好，\n\n你被邀請以「${roleText}」身分管理網站「${tenant.name}」。請在 7 天內點下列連結${user.password_hash ? "加入" : "設定密碼並加入"}：\n${inviteUrl}\n\n登入後台：${deps.baseUrl.replace(/\/$/, "")}/owner`);
  return { userId: user.id, membershipId: m.id, status: m.status, inviteUrl };
}

/* ------------------------------------------------------------------ 成員管理（店主後台；owner 角色或平台後台） */

export function requireTeamAdmin(ctx: ServiceContext) {
  if (ctx.actor.kind === "admin") return;
  if (ctx.actor.kind === "owner" && ctx.actor.role === "owner") return;
  throw new ServiceError("forbidden", "只有網站擁有者（owner）可以管理成員與 MCP token");
}

export async function listTeam(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const rows = await ctx.store.listTenantUsers(tenant.id);
  const out = [];
  for (const m of rows) {
    const u = await ctx.store.getOwnerUserById(m.user_id);
    out.push({ id: m.id, email: u?.email ?? null, name: u?.name ?? null, role: m.role, status: m.status, totp: !!u?.totp_enabled_at, lastLoginAt: u?.last_login_at ?? null, createdAt: m.created_at });
  }
  return { members: out };
}

const roleSchema = z.enum(["owner", "editor", "viewer"]);

export async function inviteTeamMember(ctx: ServiceContext, input: { site?: string | null; email: string; role: string }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const role = parseOr(roleSchema, input.role);
  const r = await inviteOwnerInternal({ store: ctx.store, ipSecret: ctx.previewSecret, baseUrl: ctx.baseUrl, sendMail: ctx.sendMail }, tenant, { email: input.email, role, by: ctx.actor.label });
  await audit(ctx, tenant.id, "team.invite", { email: input.email.trim().toLowerCase(), role });
  return { membershipId: r.membershipId, status: r.status, note: "已寄出邀請信（7 天內有效）。" };
}

async function activeOwners(store: Store, tenantId: string) {
  return (await store.listTenantUsers(tenantId)).filter((m) => m.role === "owner" && m.status === "active");
}

export async function updateTeamMember(ctx: ServiceContext, input: { site?: string | null; membershipId: string; role?: string; status?: "active" | "disabled"; confirm?: boolean; revokeTokens?: boolean }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const m = await ctx.store.getTenantUserById(tenant.id, input.membershipId);
  if (!m) throw new ServiceError("not_found", "找不到這位成員");
  const role = input.role ? parseOr(roleSchema, input.role) : m.role;
  const status = input.status ?? m.status;
  if (status === "disabled" && input.confirm !== true) throw new ServiceError("confirm_required", "停用後這位成員立即無法進入這個網站的後台。請確認後以 confirm: true 呼叫。");
  const losesOwner = m.role === "owner" && m.status === "active" && (role !== "owner" || status !== "active");
  if (losesOwner && (await activeOwners(ctx.store, tenant.id)).length <= 1) throw new ServiceError("invalid", "網站至少要有一位啟用中的擁有者（owner）");
  if (status === "active" && m.status === "invited") throw new ServiceError("invalid", "成員還沒接受邀請");
  const next = await ctx.store.updateTenantUser(tenant.id, m.id, { role, status });
  // 第九批審查 L10：停用或降級時，列出（並可一鍵撤銷）這位成員建立的手動 MCP token
  const downgraded = status === "disabled" || (m.role === "owner" && role !== "owner") || (m.role === "editor" && role === "viewer");
  const own = downgraded ? (await ctx.store.listTokens(tenant.id)).filter((t) => !t.revoked_at && t.created_by === `owner-user:${m.user_id}`) : [];
  let revokedTokens = 0;
  if (own.length && input.revokeTokens) for (const t of own) if (await ctx.store.revokeToken(t.id)) revokedTokens++;
  await audit(ctx, tenant.id, "team.update", { membershipId: m.id, role, status, revokedTokens });
  return { id: m.id, role: next?.role ?? role, status: next?.status ?? status, memberTokens: own.length, revokedTokens };
}

/* ------------------------------------------------------------------ TOTP（自己的帳號；第九批審查 L7：啟用／停用都要重新輸入密碼，啟用時發一次性復原碼） */

export const RECOVERY_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/i;
const RECOVERY_COUNT = 8;

async function requirePassword(user: OwnerUserRow, password: unknown) {
  const ok = !!user.password_hash && typeof password === "string" && (await verifyPassword(password.slice(0, MAX_PASSWORD_LENGTH), user.password_hash));
  if (!ok) throw new ServiceError("unauthorized", "密碼錯誤");
}

function newRecoveryCodes(): string[] {
  const A = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: RECOVERY_COUNT }, () => {
    let r = "";
    for (const b of randomBytes(8)) r += A[b % A.length];
    return `${r.slice(0, 4)}-${r.slice(4)}`;
  });
}

export async function beginTotpSetup(store: Store, user: OwnerUserRow, password: unknown) {
  if (user.totp_enabled_at) throw new ServiceError("conflict", "已啟用二步驟驗證");
  await requirePassword(user, password);
  const secret = newTotpSecret();
  await store.updateOwnerUser(user.id, { totp_secret_enc: encryptSecret(secret, `owner-totp:${user.id}`) });
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

export async function confirmTotpSetup(store: Store, user: OwnerUserRow, code: string, password: unknown) {
  const fresh = await store.getOwnerUserById(user.id);
  if (!fresh?.totp_secret_enc || fresh.totp_enabled_at) throw new ServiceError("invalid", "請先產生二步驟驗證金鑰");
  await requirePassword(fresh, password);
  const step = verifyTotp(decryptSecret(fresh.totp_secret_enc, `owner-totp:${user.id}`), code.trim());
  if (step === null || !(await store.claimTotpStep(user.id, step))) throw new ServiceError("invalid", "驗證碼錯誤");
  const codes = newRecoveryCodes();
  await store.updateOwnerUser(user.id, { totp_enabled_at: new Date().toISOString(), totp_recovery_hashes: codes.map((c) => sha256(c)) });
  await store.insertAudit({ tenant_id: null, actor: `owner:${user.email}`, action: "owner.totp_enable", payload: {} });
  return { enabled: true, recoveryCodes: codes };
}

export async function disableTotp(store: Store, user: OwnerUserRow, code: string, password: unknown) {
  const fresh = await store.getOwnerUserById(user.id);
  if (!fresh?.totp_enabled_at || !fresh.totp_secret_enc) throw new ServiceError("invalid", "尚未啟用二步驟驗證");
  await requirePassword(fresh, password);
  const step = verifyTotp(decryptSecret(fresh.totp_secret_enc, `owner-totp:${user.id}`), code.trim());
  if (step === null || !(await store.claimTotpStep(user.id, step))) throw new ServiceError("invalid", "驗證碼錯誤");
  await store.updateOwnerUser(user.id, { totp_enabled_at: null, totp_secret_enc: null, totp_recovery_hashes: [] });
  await store.insertAudit({ tenant_id: null, actor: `owner:${user.email}`, action: "owner.totp_disable", payload: {} });
  return { enabled: false };
}

/** 平台擁有者重設某位店主的二步驟驗證（店主遺失手機與復原碼時）：只限平台後台、寫稽核、撤銷該帳號所有 session */
export async function adminResetTotp(ctx: ServiceContext, input: { site?: string | null; membershipId: string; confirm?: boolean }) {
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "只有平台擁有者可以重設店主的二步驟驗證");
  const tenant = await resolveTenant(ctx, input.site);
  const m = await ctx.store.getTenantUserById(tenant.id, input.membershipId);
  if (!m) throw new ServiceError("not_found", "找不到這位成員");
  const u = await ctx.store.getOwnerUserById(m.user_id);
  if (!u?.totp_enabled_at) throw new ServiceError("invalid", "這位成員沒有啟用二步驟驗證");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `重設 ${u.email} 的二步驟驗證（確認過本人身分了嗎？）。請確認後以 confirm: true 呼叫。`);
  await ctx.store.updateOwnerUser(u.id, { totp_enabled_at: null, totp_secret_enc: null, totp_recovery_hashes: [] });
  const n = await ctx.store.revokeOwnerSessionsForUser(u.id);
  await audit(ctx, tenant.id, "owner.totp_admin_reset", { email: u.email, revokedSessions: n });
  return { email: u.email, reset: true };
}

/* ------------------------------------------------------------------ MCP token（店主自己網站的） */

export async function issueOwnerSiteToken(ctx: ServiceContext, input: { site?: string | null; name: string; scopes: string[] }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ServiceError("invalid", "token 名稱必填");
  const scopes = [...new Set(input.scopes)].filter((s): s is Scope => (TENANT_SCOPES as string[]).includes(s));
  if (!scopes.length || scopes.length !== new Set(input.scopes).size) throw new ServiceError("invalid", "請選擇有效的 scope（不能有平台級 scope）");
  const tok = generateToken("tenant");
  const row = await ctx.store.insertToken({ tenant_id: tenant.id, name, token_hash: tok.hash, token_prefix: tok.prefix, scopes, created_by: ctx.actor.userId ? `owner-user:${ctx.actor.userId}` : null });
  await audit(ctx, tenant.id, "token.issue", { tokenId: row.id, name, scopes, by: "owner" });
  return { id: row.id, token: tok.raw, prefix: tok.prefix, scopes };
}

export async function listOwnerSiteTokens(ctx: ServiceContext, input: { site?: string | null }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  return (await ctx.store.listTokens(tenant.id)).map(({ token_hash: _h, ...r }) => r);
}

export async function revokeOwnerSiteToken(ctx: ServiceContext, input: { site?: string | null; tokenId: string }) {
  requireTeamAdmin(ctx);
  const tenant = await resolveTenant(ctx, input.site);
  const t = await ctx.store.getToken(input.tokenId);
  if (!t || t.tenant_id !== tenant.id) throw new ServiceError("not_found", "找不到這個 token");
  const row = await ctx.store.revokeToken(t.id);
  if (!row) throw new ServiceError("conflict", "token 已經撤銷過了");
  await audit(ctx, tenant.id, "token.revoke", { tokenId: t.id, by: "owner" });
  return { id: t.id, revokedAt: row.revoked_at };
}

/** 稽核紀錄（自己網站的；任何角色可讀） */
export async function listTenantAudit(ctx: ServiceContext, input: { site?: string | null; limit?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  return ctx.store.listAudit(tenant.id, Math.max(1, Math.min(200, input.limit ?? 50)));
}

/** 這個帳號可以進入的網站（啟用中的成員） */
export async function ownerSites(store: Store, userId: string) {
  const out: { tenant: TenantRow; role: TenantRole }[] = [];
  for (const m of await store.listUserMemberships(userId)) {
    if (m.status !== "active") continue;
    const t = await store.getTenantById(m.tenant_id);
    if (t) out.push({ tenant: t, role: m.role });
  }
  return out;
}
