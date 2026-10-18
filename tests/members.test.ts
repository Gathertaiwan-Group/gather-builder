import { beforeAll, describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import {
  FORGOT_DONE,
  LOGIN_FAILED,
  REGISTER_DONE,
  RATE,
  getSessionMember,
  getMember,
  listMembers,
  loginMember,
  logoutMember,
  memberCookieName,
  registerMember,
  requestPasswordReset,
  resetPassword,
  setMemberStatus,
  sha256,
  emailKey,
  verifyEmail,
  type MemberDeps,
} from "@/lib/services/members";
import { hashPassword, verifyPassword, needsRehash } from "@/lib/members/password";
import { handleMemberPost } from "@/lib/member-routes";
import type { Store, TenantRow } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
});

function setup() {
  const store = newStore();
  const mails: { to: string; subject: string; text: string }[] = [];
  const deps: MemberDeps = { store, ipSecret: "ip-secret-xxxxxxxx", baseUrl: "http://test.local", sendMail: async (to, subject, text) => void mails.push({ to, subject, text }) };
  return { store, deps, mails };
}

async function site(store: Store, slug: string): Promise<TenantRow> {
  await createSite(ctxFor(store), { slug, name: slug, modules: ["members"] });
  return (await store.getTenantBySlug(slug))!;
}

const linkFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

describe("密碼雜湊", () => {
  it("scrypt＋每人 salt，參數寫進字串；同密碼兩次雜湊不同", async () => {
    const a = await hashPassword("correct horse");
    const b = await hashPassword("correct horse");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
    expect(needsRehash(a)).toBe(false);
    expect(needsRehash(a.replace("$16384$", "$8192$"))).toBe(true);
  });
});

describe("會員註冊／登入／登出", () => {
  it("註冊 → 登入取得 session → 讀得到會員 → 登出後 session 失效", async () => {
    const { store, deps, mails } = setup();
    const t = await site(store, "shop-a");
    const r = await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: " Amy@Example.com ", password: "password-123", name: "Amy" } });
    expect(r.message).toBe(REGISTER_DONE);
    const m = await store.getMemberByEmail(t.id, "amy@example.com");
    expect(m?.email).toBe("amy@example.com"); // 小寫正規化
    expect(m?.password_hash).not.toContain("password-123");
    expect(mails[0]?.subject).toMatch(/驗證/);

    const login = await loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "AMY@example.com", password: "password-123" });
    expect((await getSessionMember(store, t, login.token))?.member.id).toBe(m!.id);
    // DB 只存 sha256
    expect(await store.getMemberSessionByHash(login.token)).toBeNull();
    expect(await store.getMemberSessionByHash(sha256(login.token))).not.toBeNull();

    await logoutMember(store, t, login.token);
    expect(await getSessionMember(store, t, login.token)).toBeNull();
    expect((await store.getMemberSessionByHash(sha256(login.token)))?.revoked_at).toBeTruthy();
  });

  it("Email 驗證 token 一次性", async () => {
    const { store, deps, mails } = setup();
    const t = await site(store, "verify-a");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "v@example.com", password: "password-123" } });
    const tok = linkFrom(mails[0]!.text);
    await verifyEmail(store, t, tok);
    expect((await store.getMemberByEmail(t.id, "v@example.com"))?.email_verified_at).toBeTruthy();
    await expect(verifyEmail(store, t, tok)).rejects.toMatchObject({ code: "invalid" });
  });

  it("密碼少於 8 碼被拒", async () => {
    const { store, deps } = setup();
    const t = await site(store, "short-pw");
    await expect(registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "s@example.com", password: "1234567" } })).rejects.toThrow(/至少 8 碼/);
  });
});

describe("租戶隔離：A 站的帳號與 session 在 B 站完全無效", () => {
  it("同一個 email 在兩站是不同帳號；A 站 session 在 B 站讀不到會員", async () => {
    const { store, deps } = setup();
    const a = await site(store, "site-aa");
    const b = await site(store, "site-bb");
    await registerMember(deps, { tenant: a, ip: "1.1.1.1", data: { email: "same@example.com", password: "password-aaa" } });
    // B 站沒有這個帳號 → 用 A 站密碼登入 B 失敗
    await expect(loginMember(deps, { tenant: b, ip: "1.1.1.1", email: "same@example.com", password: "password-aaa" })).rejects.toThrow(LOGIN_FAILED);
    await registerMember(deps, { tenant: b, ip: "1.1.1.1", data: { email: "same@example.com", password: "password-bbb" } });
    const la = await loginMember(deps, { tenant: a, ip: "1.1.1.1", email: "same@example.com", password: "password-aaa" });
    await expect(loginMember(deps, { tenant: b, ip: "1.1.1.1", email: "same@example.com", password: "password-aaa" })).rejects.toThrow(LOGIN_FAILED);

    expect(await getSessionMember(store, a, la.token)).not.toBeNull();
    expect(await getSessionMember(store, b, la.token)).toBeNull(); // 就算 cookie 被搬到 B 站也無效
    expect(memberCookieName(a.id)).not.toBe(memberCookieName(b.id));
  });

  it("登入回應的 cookie：HttpOnly、SameSite=Lax、path 限定 /s/<slug>、名稱含租戶識別", async () => {
    const { store, deps } = setup();
    const t = await site(store, "cookie-site");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "c@example.com", password: "password-123" } });
    const req = new Request("http://test.local/s/cookie-site/api/account/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://test.local" },
      body: new URLSearchParams({ email: "c@example.com", password: "password-123" }).toString(),
    });
    const res = await handleMemberPost(req, "cookie-site", "login", store);
    expect(res.status).toBe(303);
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${memberCookieName(t.id)}=`);
    expect(sc).toMatch(/Path=\/s\/cookie-site(;|$)/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=lax/i);
    expect(res.headers.get("location")).toBe("http://test.local/s/cookie-site/account");
  });

  it("跨站 Origin 的 POST 被擋（403）", async () => {
    const { store } = setup();
    await site(store, "csrf-site");
    const req = new Request("http://test.local/s/csrf-site/api/account/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "email=a%40b.co&password=xxxxxxxx",
    });
    expect((await handleMemberPost(req, "csrf-site", "login", store)).status).toBe(403);
  });
});

describe("帳號枚舉防護：錯誤訊息一致", () => {
  it("登入：不存在的帳號、密碼錯、帳號停用 → 同一句話", async () => {
    const { store, deps } = setup();
    const t = await site(store, "enum-site");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "real@example.com", password: "password-123" } });
    const e1 = await loginMember(deps, { tenant: t, ip: "2.2.2.2", email: "nobody@example.com", password: "password-123" }).catch((e) => e);
    const e2 = await loginMember(deps, { tenant: t, ip: "2.2.2.2", email: "real@example.com", password: "wrong-password" }).catch((e) => e);
    const m = (await store.getMemberByEmail(t.id, "real@example.com"))!;
    await setMemberStatus(ctxFor(store), { site: "enum-site", memberId: m.id, status: "disabled", confirm: true });
    const e3 = await loginMember(deps, { tenant: t, ip: "2.2.2.2", email: "real@example.com", password: "password-123" }).catch((e) => e);
    for (const e of [e1, e2, e3]) {
      expect(e.code).toBe("unauthorized");
      expect(e.message).toBe(LOGIN_FAILED);
    }
  });

  it("註冊已存在的 email 與新 email 回同一句話（另寄提醒信給帳號本人）", async () => {
    const { store, deps, mails } = setup();
    const t = await site(store, "enum-reg");
    const r1 = await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "dup@example.com", password: "password-123" } });
    const r2 = await registerMember(deps, { tenant: t, ip: "1.1.1.2", data: { email: "dup@example.com", password: "another-pass" } });
    expect(r1.message).toBe(r2.message);
    expect(mails.at(-1)?.subject).toMatch(/有人嘗試/);
    // 密碼沒有被第二次註冊改掉
    await expect(loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "dup@example.com", password: "password-123" })).resolves.toBeTruthy();
  });

  it("忘記密碼：存在與不存在的 email 回同一句話，只有存在的才寄信", async () => {
    const { store, deps, mails } = setup();
    const t = await site(store, "enum-forgot");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "f@example.com", password: "password-123" } });
    const before = mails.length;
    expect((await requestPasswordReset(deps, { tenant: t, ip: "3.3.3.3", email: "f@example.com" })).message).toBe(FORGOT_DONE);
    expect((await requestPasswordReset(deps, { tenant: t, ip: "3.3.3.3", email: "ghost@example.com" })).message).toBe(FORGOT_DONE);
    expect(mails.length).toBe(before + 1);
  });
});

describe("重設密碼", () => {
  it("token 一次性；重設後舊 session 全部失效、新密碼可登入、舊密碼不行", async () => {
    const { store, deps, mails } = setup();
    const t = await site(store, "reset-site");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "r@example.com", password: "old-password" } });
    const s1 = await loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "r@example.com", password: "old-password" });
    const s2 = await loginMember(deps, { tenant: t, ip: "1.1.1.9", email: "r@example.com", password: "old-password" });
    await requestPasswordReset(deps, { tenant: t, ip: "1.1.1.1", email: "r@example.com" });
    const tok = linkFrom(mails.at(-1)!.text);

    const r = await resetPassword(deps, { tenant: t, ip: "1.1.1.1", token: tok, password: "new-password" });
    expect(r.revokedSessions).toBe(2);
    expect(await getSessionMember(store, t, s1.token)).toBeNull();
    expect(await getSessionMember(store, t, s2.token)).toBeNull();
    await expect(resetPassword(deps, { tenant: t, ip: "1.1.1.1", token: tok, password: "third-password" })).rejects.toMatchObject({ code: "invalid" });
    await expect(loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "r@example.com", password: "old-password" })).rejects.toThrow(LOGIN_FAILED);
    await expect(loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "r@example.com", password: "new-password" })).resolves.toBeTruthy();
  });

  it("過期的 token 無效；別站的 token 也無效", async () => {
    const { store, deps } = setup();
    const t = await site(store, "expired-site");
    const other = await site(store, "other-site");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "e@example.com", password: "password-123" } });
    const m = (await store.getMemberByEmail(t.id, "e@example.com"))!;
    const raw = "expired-token-xxxxxxxxxxxxxxxxxxxxxxxx";
    await store.insertMemberToken({ tenant_id: t.id, member_id: m.id, purpose: "reset_password", token_hash: sha256(raw), expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(resetPassword(deps, { tenant: t, ip: "1.1.1.1", token: raw, password: "new-password" })).rejects.toMatchObject({ code: "invalid" });
    const raw2 = "fresh-token-xxxxxxxxxxxxxxxxxxxxxxxxxx";
    await store.insertMemberToken({ tenant_id: t.id, member_id: m.id, purpose: "reset_password", token_hash: sha256(raw2), expires_at: new Date(Date.now() + 60_000).toISOString() });
    await expect(resetPassword(deps, { tenant: other, ip: "1.1.1.1", token: raw2, password: "new-password" })).rejects.toMatchObject({ code: "invalid" });
    // 驗證信 token 不能拿來重設密碼
    const raw3 = "verify-token-xxxxxxxxxxxxxxxxxxxxxxxxx";
    await store.insertMemberToken({ tenant_id: t.id, member_id: m.id, purpose: "verify_email", token_hash: sha256(raw3), expires_at: new Date(Date.now() + 60_000).toISOString() });
    await expect(resetPassword(deps, { tenant: t, ip: "1.1.1.1", token: raw3, password: "new-password" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("限流", () => {
  it(`登入每 IP ${RATE.loginIp.limit} 次／15 分鐘，之後 rate_limited（帳號是否存在都一樣）`, async () => {
    const { store, deps } = setup();
    const t = await site(store, "rate-site");
    for (let i = 0; i < RATE.loginIp.limit; i++) {
      await expect(loginMember(deps, { tenant: t, ip: "9.9.9.9", email: `x${i}@example.com`, password: "whatever-1" })).rejects.toMatchObject({ code: "unauthorized" });
    }
    await expect(loginMember(deps, { tenant: t, ip: "9.9.9.9", email: "x@example.com", password: "whatever-1" })).rejects.toMatchObject({ code: "rate_limited" });
    // 別的 IP 不受影響
    await expect(loginMember(deps, { tenant: t, ip: "8.8.8.8", email: "x@example.com", password: "whatever-1" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("L3：同 email＋同 IP 超過門檻 → rate_limited；同 email 換 IP 不會被鎖死（帳號本人仍可登入）", async () => {
    const { store, deps } = setup();
    const t = await site(store, "rate-email");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "target@example.com", password: "real-password" } });
    for (let i = 0; i < RATE.loginEmailIp.limit; i++) {
      await loginMember(deps, { tenant: t, ip: "10.0.0.1", email: "target@example.com", password: "guess-0000" }).catch(() => undefined);
    }
    await expect(loginMember(deps, { tenant: t, ip: "10.0.0.1", email: "target@example.com", password: "guess-0000" })).rejects.toMatchObject({ code: "rate_limited" });
    // 本人從別的 IP 登入不受影響
    await expect(loginMember(deps, { tenant: t, ip: "10.9.9.9", email: "target@example.com", password: "real-password" })).resolves.toBeTruthy();
  });

  it("L3：email 單獨（跨 IP）超過高門檻後只會被延遲，不會被鎖", async () => {
    const { store, deps } = setup();
    const d = { ...deps, slowdownMs: 30 };
    const t = await site(store, "rate-email2");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "victim@example.com", password: "real-password" } });
    const key = "victim@example.com";
    // 模擬大量來自不同 IP 的猜測：直接打滿 email 單獨的桶（不跑 100 次 scrypt，CI 才不會逾時）
    for (let i = 0; i < RATE.loginEmail.limit; i++) await store.rateHit(`member-login-email:${t.id}`, emailKey(key, deps.ipSecret), RATE.loginEmail.window, RATE.loginEmail.limit);
    await loginMember(d, { tenant: t, ip: "10.1.0.1", email: key, password: "guess" }).catch(() => undefined); // 第 101 次：被延遲但仍回「密碼錯誤」而非鎖住
    const started = Date.now();
    await expect(loginMember(d, { tenant: t, ip: "10.200.0.1", email: key, password: "real-password" })).resolves.toBeTruthy();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("L2：忘記密碼有 defer 時寄信排到回應之後，且帳號存在與否回應同一句話", async () => {
    const { store, deps } = setup();
    const t = await site(store, "forgot-timing");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "real@example.com", password: "password-123" } });
    const deferred: Promise<unknown>[] = [];
    const sent: string[] = [];
    const d = { ...deps, sendMail: async (to: string) => void sent.push(to), defer: (p: Promise<unknown>) => void deferred.push(p) };
    const a = await requestPasswordReset(d, { tenant: t, ip: "2.2.2.2", email: "real@example.com" });
    const b = await requestPasswordReset(d, { tenant: t, ip: "2.2.2.2", email: "ghost@example.com" });
    expect(a.message).toBe(b.message);
    expect(deferred).toHaveLength(1); // 只有真的帳號排了寄信，但不在回應路徑上 await
    await Promise.all(deferred);
    expect(sent).toEqual(["real@example.com"]);
  });

  it(`註冊每 IP ${RATE.registerIp.limit} 次／小時`, async () => {
    const { store, deps } = setup();
    const t = await site(store, "rate-reg");
    for (let i = 0; i < RATE.registerIp.limit; i++) await registerMember(deps, { tenant: t, ip: "7.7.7.7", data: { email: `r${i}@example.com`, password: "password-123" } });
    await expect(registerMember(deps, { tenant: t, ip: "7.7.7.7", data: { email: "rx@example.com", password: "password-123" } })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("沒設 RESEND_API_KEY：不報錯，連結寫進 server log", () => {
  it("registerMember 無 sendMail 時 console.log 驗證連結", async () => {
    const store = newStore();
    const t = await site(store, "nomail-site");
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await registerMember({ store, ipSecret: "x-secret-xxxxx", baseUrl: "http://test.local" }, { tenant: t, ip: "1.1.1.1", data: { email: "n@example.com", password: "password-123" } });
    expect(spy.mock.calls.flat().join(" ")).toMatch(/\/s\/nomail-site\/account\/verify\?token=/);
    spy.mockRestore();
  });
});

describe("MCP／後台的會員工具", () => {
  const tokenActor = (tenantId: string, scopes: Actor["scopes"]): Actor => ({ kind: "token", label: "t", tenantId, scopes });

  it("list/get 需要 members:read，不回傳密碼雜湊；停用需要 members:write＋confirm，停用後 session 失效", async () => {
    const { store, deps } = setup();
    const t = await site(store, "mcp-members");
    await registerMember(deps, { tenant: t, ip: "1.1.1.1", data: { email: "m@example.com", password: "password-123" } });
    const s = await loginMember(deps, { tenant: t, ip: "1.1.1.1", email: "m@example.com", password: "password-123" });

    await expect(listMembers(ctxFor(store, tokenActor(t.id, ["site:read"])), {})).rejects.toMatchObject({ code: "forbidden" });
    const reader = ctxFor(store, tokenActor(t.id, ["members:read"]));
    const list = await listMembers(reader, {});
    expect(list.total).toBe(1);
    expect(JSON.stringify(list)).not.toMatch(/scrypt|password/);
    const one = await getMember(reader, { email: "M@example.com" });
    expect(JSON.stringify(one)).not.toMatch(/scrypt|password_hash/);

    await expect(setMemberStatus(reader, { memberId: one.id, status: "disabled", confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    const writer = ctxFor(store, tokenActor(t.id, ["members:write"]));
    await expect(setMemberStatus(writer, { memberId: one.id, status: "disabled" })).rejects.toMatchObject({ code: "confirm_required" });
    const r = await setMemberStatus(writer, { memberId: one.id, status: "disabled", confirm: true });
    expect(r.revokedSessions).toBe(1);
    expect(await getSessionMember(store, t, s.token)).toBeNull();
  });
});
