import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { getModule } from "@/modules/registry";
import type { MemberRow, Store, TenantRow } from "../store/types";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, burnPasswordCheck, hashPassword, verifyPassword } from "../members/password";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { hashIp } from "./inquiries";

/**
 * members 模組：平台自管的會員帳號（不用 Supabase Auth）。
 *
 * 隔離設計（A 站的會員在 B 站完全不存在）：
 * - 帳號唯一性是 (tenant_id, email)；同一個 email 在不同網站是不同帳號、不同密碼。
 * - session cookie 名含租戶識別、path 限定 /s/<slug>（瀏覽器不會把 A 站 cookie 送到 B 站）；
 *   server 端另外比對 session.tenant_id === 目前網站，cookie 被搬到別站也無效。
 * - DB 只存 session／token 的 sha256。
 */

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const VERIFY_TTL_SECONDS = 48 * 60 * 60;
export const RESET_TTL_SECONDS = 60 * 60;

export const RATE = {
  /** 每 IP（不分帳號） */
  loginIp: { limit: 30, window: 15 * 60 },
  /** 主要門檻：同一 email＋同一 IP */
  loginEmailIp: { limit: 10, window: 15 * 60 },
  /** email 單獨（跨 IP）：門檻高，而且超過只「延遲」不鎖死，避免被拿來鎖住特定會員（L3） */
  loginEmail: { limit: 100, window: 15 * 60 },
  registerIp: { limit: 5, window: 60 * 60 },
  forgotIp: { limit: 5, window: 60 * 60 },
  forgotEmail: { limit: 3, window: 60 * 60 },
  resetIp: { limit: 10, window: 60 * 60 },
} as const;

/** 登入失敗一律同一句：不洩漏帳號是否存在、是否被停用 */
export const LOGIN_FAILED = "Email 或密碼錯誤";
export const REGISTER_DONE = "註冊完成。若這個 Email 之前未註冊過，帳號已建立並寄出驗證信；請直接登入。忘記密碼可使用「忘記密碼」。";
export const FORGOT_DONE = "如果這個 Email 有註冊，我們已寄出重設密碼連結（1 小時內有效）。";
export const TOKEN_INVALID = "連結無效或已過期，請重新申請。";

export type SendMail = (to: string, subject: string, text: string) => Promise<void>;

export interface MemberDeps {
  store: Store;
  /** IP／email 雜湊金鑰（PREVIEW_SECRET） */
  ipSecret: string;
  /** 對外網址，例如 https://gather-builder.vercel.app */
  baseUrl: string;
  sendMail?: SendMail;
  /**
   * 把寄信排到回應之後（Next 的 after()）。忘記密碼用它讓「帳號存在／不存在」的回應時間一致（L2）；
   * 沒給就直接 await（測試）。
   */
  defer?: (task: Promise<unknown>) => void;
  /** 測試用：覆寫登入延遲 */
  slowdownMs?: number;
}

/** 超過 email 單獨門檻時每次登入嘗試的延遲（毫秒） */
export const LOGIN_EMAIL_SLOWDOWN_MS = 1500;
/** 忘記密碼回應的最短時間（毫秒），抹平查 DB／發 token 的時間差 */
export const FORGOT_MIN_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const newRawToken = () => randomBytes(32).toString("base64url");
export const emailKey = (email: string, secret: string) => createHmac("sha256", secret).update(`email:${email}`).digest("hex").slice(0, 32);

/** cookie 名含租戶識別（tenant id 前 12 碼），path 限定 /s/<slug> */
export function memberCookieName(tenantId: string): string {
  return `gbm_${tenantId.replace(/-/g, "").slice(0, 12)}`;
}
export function memberCookiePath(slug: string): string {
  return `/s/${slug}`;
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: "Email 格式不正確" }));
const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, { message: `密碼至少 ${MIN_PASSWORD_LENGTH} 碼` })
  .max(MAX_PASSWORD_LENGTH, { message: "密碼太長" });
const nameSchema = z.string().trim().max(80).optional();
const phoneSchema = z.string().trim().max(40).optional();

function parseOr<T extends z.ZodType>(schema: T, v: unknown): z.output<T> {
  const r = schema.safeParse(v);
  if (!r.success) throw new ServiceError("invalid", r.error.issues.map((i) => i.message).join("；"));
  return r.data;
}

/** 前台入口共用：網站存在、未停用、members 模組已開通 */
export async function loadMemberTenant(store: Store, slug: string): Promise<TenantRow> {
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant || tenant.status === "suspended") throw new ServiceError("not_found", "找不到網站");
  if (!activeModuleIds(await moduleStates({ store }, tenant.id)).has("members")) throw new ServiceError("forbidden", "此網站未開放會員功能");
  return tenant;
}

/** 讀已發布快照裡的模組設定（草稿的設定還沒生效） */
export async function publishedModuleSettings(store: Store, tenant: TenantRow, moduleId: string): Promise<Record<string, unknown>> {
  if (!tenant.published_revision_id) return {};
  const rev = await store.getRevision(tenant.published_revision_id);
  const raw = rev?.content.moduleSettings?.[moduleId] ?? {};
  const m = getModule(moduleId);
  const r = m?.settingsSchema.safeParse(raw);
  return r?.success ? r.data : {};
}

async function limit(deps: MemberDeps, bucket: string, key: string, rule: { limit: number; window: number }) {
  const hit = await deps.store.rateHit(bucket, key, rule.window, rule.limit);
  if (!hit.allowed) throw new ServiceError("rate_limited", "嘗試太多次，請稍後再試");
}

function siteUrl(deps: MemberDeps, tenant: TenantRow, path: string) {
  return `${deps.baseUrl.replace(/\/$/, "")}/s/${tenant.slug}${path}`;
}

/** 寄信；沒設 RESEND_API_KEY 時不報錯，把內容（含連結）寫進 server log 方便本機測試 */
async function deliver(deps: MemberDeps, to: string, subject: string, text: string) {
  if (!deps.sendMail) {
    console.log(`[members] RESEND_API_KEY 未設定，未寄出「${subject}」給 ${to.replace(/(.{2}).*@/, "$1***@")}：\n${text}`);
    return;
  }
  try {
    await deps.sendMail(to, subject, text);
  } catch (e) {
    console.error("[members] 寄信失敗", e instanceof Error ? e.message : e);
  }
}

async function issueMemberToken(deps: MemberDeps, tenant: TenantRow, member: MemberRow, purpose: "verify_email" | "reset_password") {
  const raw = newRawToken();
  const ttl = purpose === "verify_email" ? VERIFY_TTL_SECONDS : RESET_TTL_SECONDS;
  await deps.store.insertMemberToken({
    tenant_id: tenant.id,
    member_id: member.id,
    purpose,
    token_hash: sha256(raw),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  });
  return raw;
}

/* ------------------------------------------------------------------ 註冊 */

export async function registerMember(
  deps: MemberDeps,
  input: { tenant: TenantRow; ip: string; data: { email?: unknown; password?: unknown; name?: unknown; phone?: unknown } },
): Promise<{ message: string }> {
  const { tenant } = input;
  const cfg = (await publishedModuleSettings(deps.store, tenant, "members")) as { allowRegistration?: boolean };
  if (cfg.allowRegistration === false) throw new ServiceError("forbidden", "此網站目前不開放註冊");
  await limit(deps, `member-register:${tenant.id}`, hashIp(input.ip || "unknown", deps.ipSecret), RATE.registerIp);
  const email = parseOr(emailSchema, input.data.email);
  const password = parseOr(passwordSchema, input.data.password);
  const name = parseOr(nameSchema, input.data.name ?? undefined) || null;
  const phone = parseOr(phoneSchema, input.data.phone ?? undefined) || null;

  // 不論帳號是否已存在都先算雜湊（回應時間一致）
  const password_hash = await hashPassword(password);
  const created = await deps.store.insertMember({ tenant_id: tenant.id, email, password_hash, name, phone });
  if (created) {
    const raw = await issueMemberToken(deps, tenant, created, "verify_email");
    await deliver(
      deps,
      email,
      `【${tenant.name}】請驗證你的 Email`,
      `歡迎加入 ${tenant.name}！\n\n請點下列連結完成 Email 驗證（48 小時內有效）：\n${siteUrl(deps, tenant, `/account/verify?token=${raw}`)}\n\n如果不是你本人註冊，請忽略這封信。`,
    );
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "member:self", action: "member.register", payload: { memberId: created.id } });
  } else {
    // 已有帳號：回同一句話，另寄一封提醒信給帳號本人（不讓第三者從畫面得知帳號存在）
    await deliver(
      deps,
      email,
      `【${tenant.name}】有人嘗試用你的 Email 註冊`,
      `你在 ${tenant.name} 已經有帳號了。若忘記密碼，請到這裡重設：\n${siteUrl(deps, tenant, "/account/forgot")}\n\n如果不是你本人操作，請忽略這封信。`,
    );
  }
  return { message: REGISTER_DONE };
}

/* ------------------------------------------------------------------ 登入／登出／session */

export async function loginMember(
  deps: MemberDeps,
  input: { tenant: TenantRow; ip: string; ua?: string | null; email?: unknown; password?: unknown },
): Promise<{ token: string; expiresAt: Date; member: MemberRow }> {
  const { tenant } = input;
  const ipHash = hashIp(input.ip || "unknown", deps.ipSecret);
  await limit(deps, `member-login:${tenant.id}`, ipHash, RATE.loginIp);
  const emailParsed = emailSchema.safeParse(input.email);
  const password = typeof input.password === "string" ? input.password.slice(0, MAX_PASSWORD_LENGTH) : "";
  if (!emailParsed.success || !password) {
    await burnPasswordCheck(password || "x");
    throw new ServiceError("unauthorized", LOGIN_FAILED);
  }
  const email = emailParsed.data;
  // 主要門檻是 email＋IP；email 單獨的門檻只會讓每次嘗試變慢，不會把帳號本人鎖在外面
  await limit(deps, `member-login-eip:${tenant.id}`, `${emailKey(email, deps.ipSecret)}:${ipHash}`, RATE.loginEmailIp);
  const perEmail = await deps.store.rateHit(`member-login-email:${tenant.id}`, emailKey(email, deps.ipSecret), RATE.loginEmail.window, RATE.loginEmail.limit);
  if (!perEmail.allowed) await sleep(deps.slowdownMs ?? LOGIN_EMAIL_SLOWDOWN_MS);

  const member = await deps.store.getMemberByEmail(tenant.id, email);
  if (!member) {
    await burnPasswordCheck(password);
    throw new ServiceError("unauthorized", LOGIN_FAILED);
  }
  const ok = await verifyPassword(password, member.password_hash);
  if (!ok || member.status !== "active") throw new ServiceError("unauthorized", LOGIN_FAILED);

  const raw = newRawToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await deps.store.insertMemberSession({
    tenant_id: tenant.id,
    member_id: member.id,
    token_hash: sha256(raw),
    expires_at: expiresAt.toISOString(),
    ip: ipHash,
    ua: input.ua?.slice(0, 300) ?? null,
  });
  await deps.store.updateMember(tenant.id, member.id, { last_login_at: new Date().toISOString() });
  return { token: raw, expiresAt, member };
}

/**
 * 由 cookie 原文取得目前會員。全部條件都要成立才算登入：
 * session 存在、屬於「這個網站」、未撤銷、未過期、會員是 active。
 */
export async function getSessionMember(store: Store, tenant: TenantRow, token: string | null | undefined): Promise<{ member: MemberRow; sessionId: string } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const s = await store.getMemberSessionByHash(sha256(token));
  if (!s || s.tenant_id !== tenant.id || s.revoked_at || new Date(s.expires_at).getTime() <= Date.now()) return null;
  const member = await store.getMemberById(tenant.id, s.member_id);
  if (!member || member.status !== "active") return null;
  return { member, sessionId: s.id };
}

export async function logoutMember(store: Store, tenant: TenantRow, token: string | null | undefined): Promise<void> {
  const cur = await getSessionMember(store, tenant, token);
  if (cur) await store.revokeMemberSession(tenant.id, cur.sessionId);
}

export async function updateOwnProfile(store: Store, tenant: TenantRow, member: MemberRow, data: { name?: unknown; phone?: unknown }) {
  const name = parseOr(nameSchema, data.name ?? undefined) || null;
  const phone = parseOr(phoneSchema, data.phone ?? undefined) || null;
  return store.updateMember(tenant.id, member.id, { name, phone });
}

/* ------------------------------------------------------------------ 忘記密碼／重設／驗證 */

export async function requestPasswordReset(deps: MemberDeps, input: { tenant: TenantRow; ip: string; email?: unknown }): Promise<{ message: string }> {
  const { tenant } = input;
  const started = Date.now();
  await limit(deps, `member-forgot:${tenant.id}`, hashIp(input.ip || "unknown", deps.ipSecret), RATE.forgotIp);
  const parsed = emailSchema.safeParse(input.email);
  if (!parsed.success) throw new ServiceError("invalid", "Email 格式不正確");
  const email = parsed.data;
  await limit(deps, `member-forgot-email:${tenant.id}`, emailKey(email, deps.ipSecret), RATE.forgotEmail);
  const member = await deps.store.getMemberByEmail(tenant.id, email);
  if (member && member.status === "active") {
    const raw = await issueMemberToken(deps, tenant, member, "reset_password");
    const send = deliver(
      deps,
      email,
      `【${tenant.name}】重設密碼`,
      `請點下列連結設定新密碼（1 小時內有效，只能使用一次）：\n${siteUrl(deps, tenant, `/account/reset?token=${raw}`)}\n\n如果不是你本人申請，請忽略這封信，你的密碼不會改變。`,
    );
    // L2：寄信（數百毫秒）排到回應之後，否則回應時間就能分辨帳號是否存在
    if (deps.defer) deps.defer(send);
    else await send;
  }
  const wait = FORGOT_MIN_MS - (Date.now() - started);
  if (wait > 0 && deps.defer) await sleep(wait);
  return { message: FORGOT_DONE };
}

/** 重設密碼：token 一次性（條件更新），成功後撤銷該會員所有 session */
export async function resetPassword(deps: MemberDeps, input: { tenant: TenantRow; ip: string; token?: unknown; password?: unknown }): Promise<{ message: string; revokedSessions: number }> {
  const { tenant } = input;
  await limit(deps, `member-reset:${tenant.id}`, hashIp(input.ip || "unknown", deps.ipSecret), RATE.resetIp);
  const password = parseOr(passwordSchema, input.password);
  const raw = typeof input.token === "string" ? input.token : "";
  if (raw.length < 20 || raw.length > 200) throw new ServiceError("invalid", TOKEN_INVALID);
  const used = await deps.store.consumeMemberToken(tenant.id, sha256(raw), "reset_password", new Date().toISOString());
  if (!used) throw new ServiceError("invalid", TOKEN_INVALID);
  const member = await deps.store.getMemberById(tenant.id, used.member_id);
  if (!member || member.status !== "active") throw new ServiceError("invalid", TOKEN_INVALID);
  // 能收到重設信＝擁有這個信箱，順便視為已驗證
  await deps.store.updateMember(tenant.id, member.id, { password_hash: await hashPassword(password), email_verified_at: member.email_verified_at ?? new Date().toISOString() });
  const revokedSessions = await deps.store.revokeAllMemberSessions(tenant.id, member.id);
  // 其他較早寄出、尚未使用的重設連結一併失效
  await deps.store.invalidateMemberTokens(tenant.id, member.id, "reset_password");
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: "member:self", action: "member.password_reset", payload: { memberId: member.id, revokedSessions } });
  return { message: "密碼已更新，請用新密碼登入（其他裝置已全部登出）。", revokedSessions };
}

export async function verifyEmail(store: Store, tenant: TenantRow, token: unknown): Promise<{ message: string }> {
  const raw = typeof token === "string" ? token : "";
  if (raw.length < 20 || raw.length > 200) throw new ServiceError("invalid", TOKEN_INVALID);
  const used = await store.consumeMemberToken(tenant.id, sha256(raw), "verify_email", new Date().toISOString());
  if (!used) throw new ServiceError("invalid", TOKEN_INVALID);
  await store.updateMember(tenant.id, used.member_id, { email_verified_at: new Date().toISOString() });
  return { message: "Email 驗證完成。" };
}

/* ------------------------------------------------------------------ 後台／MCP */

export function memberPublic(m: MemberRow) {
  // 🔴 絕不回傳 password_hash
  return {
    id: m.id,
    email: m.email,
    name: m.name,
    phone: m.phone,
    status: m.status,
    emailVerified: !!m.email_verified_at,
    emailVerifiedAt: m.email_verified_at,
    createdAt: m.created_at,
    lastLoginAt: m.last_login_at,
  };
}

async function requireMembersModule(ctx: ServiceContext, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("members")) {
    throw new ServiceError("forbidden", "此網站未啟用模組「members」，請先 enable_module members");
  }
}

export async function listMembers(ctx: ServiceContext, input: { site?: string | null; limit?: number; offset?: number; q?: string }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireMembersModule(ctx, tenant);
  const lim = Math.max(1, Math.min(100, input.limit ?? 20));
  const r = await ctx.store.listMembers(tenant.id, { limit: lim, offset: Math.max(0, input.offset ?? 0), q: input.q?.trim().slice(0, 100) || undefined });
  return { total: r.total, members: r.rows.map(memberPublic) };
}

export async function getMember(ctx: ServiceContext, input: { site?: string | null; memberId?: string; email?: string }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireMembersModule(ctx, tenant);
  const m = input.memberId
    ? await ctx.store.getMemberById(tenant.id, input.memberId)
    : input.email
      ? await ctx.store.getMemberByEmail(tenant.id, input.email.trim().toLowerCase())
      : null;
  if (!m) throw new ServiceError("not_found", "找不到會員（請給 memberId 或 email）");
  const orders = await ctx.store.listOrders(tenant.id, { memberId: m.id, limit: 1, offset: 0 });
  return { ...memberPublic(m), orderCount: orders.total };
}

/** 停用（或重新啟用）會員；停用時撤銷所有 session。需要 members:write ＋ confirm: true */
export async function setMemberStatus(ctx: ServiceContext, input: { site?: string | null; memberId: string; status: "active" | "disabled"; confirm?: boolean }) {
  requireScope(ctx, "members:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireMembersModule(ctx, tenant);
  const m = await ctx.store.getMemberById(tenant.id, input.memberId);
  if (!m) throw new ServiceError("not_found", `找不到會員 ${input.memberId}`);
  if (input.confirm !== true) {
    throw new ServiceError("confirm_required", `${input.status === "disabled" ? "停用" : "啟用"}會員 ${m.email} 會立即影響他能否登入。請先讓使用者確認，再以 confirm: true 呼叫。`);
  }
  if (m.status === input.status) return { ...memberPublic(m), changed: false, revokedSessions: 0 };
  const row = await ctx.store.updateMember(tenant.id, m.id, { status: input.status });
  const revokedSessions = input.status === "disabled" ? await ctx.store.revokeAllMemberSessions(tenant.id, m.id) : 0;
  await audit(ctx, tenant.id, input.status === "disabled" ? "member.disable" : "member.enable", { memberId: m.id, revokedSessions });
  return { ...memberPublic(row!), changed: true, revokedSessions };
}
