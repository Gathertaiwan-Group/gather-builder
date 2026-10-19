/**
 * 第九批（2）：店主後台帳號與權限。
 * - 登入（錯誤訊息一致、限流）、session（存雜湊、閒置與絕對到期、登出撤銷、重設密碼撤銷全部）、邀請（設定密碼）、TOTP（二步驟、防重放）。
 * - 角色：viewer 不能寫、editor 不能改金流憑證／網域／成員／token、owner 全部；跨租戶一律拒絕；至少保留一位 owner。
 * 記憶體 Store；🔴 不寄任何信（sendMail 收進陣列）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { createSite, updateSection, getSite } from "@/lib/services/sites";
import { createProduct } from "@/lib/services/shop";
import { saveProviderAccount, listOrders } from "@/lib/services/orders";
import { addDomain } from "@/lib/services/domains";
import { createMockDomainAdapter } from "@/lib/domains/adapter";
import {
  OWNER_LOGIN_FAILED,
  OWNER_SESSION_IDLE_MS,
  OWNER_SESSION_ABSOLUTE_MS,
  adminResetTotp,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  getOwnerSession,
  inviteOwnerInternal,
  inviteTeamMember,
  issueOwnerSiteToken,
  listTeam,
  ownerAcceptInvite,
  ownerActor,
  ownerForgotPassword,
  ownerLogin,
  ownerLogout,
  ownerResetPassword,
  ownerVerifyMfa,
  revokeOwnerSiteToken,
  scopesForRole,
  updateTeamMember,
  type OwnerDeps,
} from "@/lib/services/owners";
import { totpCode, verifyTotp, base32Decode, hotp } from "@/lib/owner/totp";
import { authenticateBearer } from "@/lib/tokens";
import type { Store, TenantRow } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 3).toString("base64");
});

function deps(store: Store) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const d: OwnerDeps = { store, ipSecret: "test-ip-secret", baseUrl: "https://builder.example", sendMail: async (to, subject, text) => void sent.push({ to, subject, text }) };
  return { d, sent };
}
const linkToken = (text: string, path: string) => decodeURIComponent(new RegExp(`${path}\\?t=([^\\s]+)`).exec(text)![1]!);

/** 邀請 → 接受 → 登入，回傳 session token 與成員資料 */
async function onboard(store: Store, tenant: TenantRow, email: string, role: "owner" | "editor" | "viewer", password = "correct-horse-1") {
  const { d, sent } = deps(store);
  await inviteOwnerInternal(d, tenant, { email, role, by: "test" });
  const tok = linkToken(sent.at(-1)!.text, "/owner/invite");
  await ownerAcceptInvite(d, { token: tok, password, ip: "1.1.1.1" });
  const s = await ownerLogin(d, { email, password, ip: "1.1.1.1" });
  if (s.kind !== "session") throw new Error("expected session");
  const user = (await store.getOwnerUserByEmail(email))!;
  const m = (await store.getTenantUser(tenant.id, user.id))!;
  return { token: s.token, user, m, d, sent };
}

describe("店主登入與 session", () => {
  it("邀請 → 設定密碼 → 登入；錯誤一律同一句；邀請連結一次性；session 只存雜湊", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-a");
    const { d, sent } = deps(store);
    await inviteOwnerInternal(d, shop.tenant, { email: "Boss@Example.com", role: "owner", by: "test" });
    expect(sent[0]!.to).toBe("boss@example.com");
    const tok = linkToken(sent[0]!.text, "/owner/invite");
    // 還沒設密碼不能登入
    await expect(ownerLogin(d, { email: "boss@example.com", password: "whatever-123", ip: "1.1.1.1" })).rejects.toThrow(OWNER_LOGIN_FAILED);
    await expect(ownerAcceptInvite(d, { token: tok, password: "short", ip: "1.1.1.1" })).rejects.toThrow(/至少 8 碼/);
    await ownerAcceptInvite(d, { token: tok, password: "correct-horse-1", ip: "1.1.1.1" });
    await expect(ownerAcceptInvite(d, { token: tok, password: "correct-horse-1", ip: "1.1.1.1" })).rejects.toThrow(/無效或已過期/);
    await expect(ownerLogin(d, { email: "boss@example.com", password: "wrong-password", ip: "1.1.1.1" })).rejects.toThrow(OWNER_LOGIN_FAILED);
    await expect(ownerLogin(d, { email: "nobody@example.com", password: "wrong-password", ip: "1.1.1.1" })).rejects.toThrow(OWNER_LOGIN_FAILED);
    const s = await ownerLogin(d, { email: "BOSS@example.com", password: "correct-horse-1", ip: "1.1.1.1" });
    expect(s.kind).toBe("session");
    if (s.kind !== "session") return;
    expect(s.token).toMatch(/^gbs_/);
    const row = (await store.getOwnerSessionByHash(createHash("sha256").update(s.token).digest("hex")))!;
    expect(row.token_hash).not.toContain(s.token);
    expect((await getOwnerSession(store, s.token))!.user.email).toBe("boss@example.com");
    expect((await store.getTenantUser(shop.tenant.id, row.user_id))!.status).toBe("active");
  });

  it("session：登出撤銷、閒置 12 小時到期、絕對 7 天到期、偽造 token 無效", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-sess");
    const a = await onboard(store, shop.tenant, "a@example.com", "owner");
    const now = Date.now();
    expect(await getOwnerSession(store, a.token, now)).not.toBeNull();
    expect(await getOwnerSession(store, a.token, now + OWNER_SESSION_IDLE_MS + 1000)).toBeNull(); // 閒置到期當下撤銷
    expect(await getOwnerSession(store, a.token, now)).toBeNull(); // 已被撤銷
    const s2 = await ownerLogin(a.d, { email: "a@example.com", password: "correct-horse-1", ip: "1.1.1.1" });
    if (s2.kind !== "session") throw new Error();
    expect(await getOwnerSession(store, s2.token, now + OWNER_SESSION_ABSOLUTE_MS + 1000)).toBeNull();
    const s3 = await ownerLogin(a.d, { email: "a@example.com", password: "correct-horse-1", ip: "1.1.1.1" });
    if (s3.kind !== "session") throw new Error();
    await ownerLogout(store, s3.token);
    expect(await getOwnerSession(store, s3.token)).toBeNull();
    expect(await getOwnerSession(store, "gbs_" + "A".repeat(43))).toBeNull();
    expect(await getOwnerSession(store, "not-a-token")).toBeNull();
  });

  it("忘記密碼：不存在的 email 回同一句；重設後舊密碼失效、所有 session 撤銷、連結一次性", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-reset");
    const a = await onboard(store, shop.tenant, "r@example.com", "owner");
    const r1 = await ownerForgotPassword(a.d, { email: "nobody@example.com", ip: "2.2.2.2" });
    const r2 = await ownerForgotPassword(a.d, { email: "r@example.com", ip: "2.2.2.2" });
    expect(r1.message).toBe(r2.message);
    const tok = linkToken(a.sent.at(-1)!.text, "/owner/reset");
    await ownerResetPassword(a.d, { token: tok, password: "new-password-9", ip: "2.2.2.2" });
    expect(await getOwnerSession(store, a.token)).toBeNull();
    await expect(ownerLogin(a.d, { email: "r@example.com", password: "correct-horse-1", ip: "2.2.2.2" })).rejects.toThrow(OWNER_LOGIN_FAILED);
    expect((await ownerLogin(a.d, { email: "r@example.com", password: "new-password-9", ip: "2.2.2.2" })).kind).toBe("session");
    await expect(ownerResetPassword(a.d, { token: tok, password: "again-password", ip: "2.2.2.2" })).rejects.toThrow(/無效或已過期/);
  });

  it("登入限流：同 email＋IP 15 分鐘 10 次", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-rl");
    const a = await onboard(store, shop.tenant, "rl@example.com", "owner");
    for (let i = 0; i < 10; i++) await expect(ownerLogin(a.d, { email: "rl@example.com", password: "nope-nope", ip: "9.9.9.9" })).rejects.toThrow(OWNER_LOGIN_FAILED);
    await expect(ownerLogin(a.d, { email: "rl@example.com", password: "nope-nope", ip: "9.9.9.9" })).rejects.toThrow(/太多次/);
    await expect(ownerLogin(a.d, { email: "rl@example.com", password: "correct-horse-1", ip: "9.9.9.9" })).rejects.toThrow(/太多次/);
  });
});

describe("TOTP 二步驟", () => {
  it("RFC 6238 範例向量（SHA1）", () => {
    // RFC 6238 附錄 B：secret "12345678901234567890"，T=59 → 94287082（8 位），6 位為 287082
    const key = Buffer.from("12345678901234567890");
    expect(hotp(key, 1, 8)).toBe("94287082");
    expect(hotp(key, 37037036, 8)).toBe("07081804");
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString()).toBe("12345678901234567890");
  });

  it("啟用後登入要輸入驗證碼；輸錯不讓 ticket 失效；同一組碼不能重放", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-totp");
    const a = await onboard(store, shop.tenant, "t@example.com", "owner");
    await expect(beginTotpSetup(store, a.user, "wrong-password")).rejects.toThrow(/密碼錯誤/);
    const { secret } = await beginTotpSetup(store, a.user, "correct-horse-1");
    await expect(confirmTotpSetup(store, a.user, "000000", "correct-horse-1")).rejects.toThrow(/驗證碼錯誤/);
    const t0 = Date.now() - 60_000; // 用兩個時間步以前的碼啟用，留下「最後用過的時間步」
    expect(verifyTotp(secret, totpCode(secret))).not.toBeNull();
    await expect(confirmTotpSetup(store, a.user, totpCode(secret, t0 + 30_000), "nope")).rejects.toThrow(/密碼錯誤/);
    const en = await confirmTotpSetup(store, a.user, totpCode(secret, t0 + 30_000), "correct-horse-1");
    expect(en.recoveryCodes).toHaveLength(8);
    const r = await ownerLogin(a.d, { email: "t@example.com", password: "correct-horse-1", ip: "3.3.3.3" });
    expect(r.kind).toBe("mfa");
    if (r.kind !== "mfa") return;
    await expect(ownerVerifyMfa(a.d, { ticket: r.ticket, code: "123456", ip: "3.3.3.3" })).rejects.toThrow(/驗證碼錯誤/);
    const code = totpCode(secret);
    const ok = await ownerVerifyMfa(a.d, { ticket: r.ticket, code, ip: "3.3.3.3" });
    expect(ok.kind).toBe("session");
    // ticket 已用掉；同一組碼重放（新 ticket）也被拒
    await expect(ownerVerifyMfa(a.d, { ticket: r.ticket, code, ip: "3.3.3.3" })).rejects.toThrow(/逾時/);
    const r2 = await ownerLogin(a.d, { email: "t@example.com", password: "correct-horse-1", ip: "3.3.3.3" });
    if (r2.kind !== "mfa") throw new Error();
    await expect(ownerVerifyMfa(a.d, { ticket: r2.ticket, code, ip: "3.3.3.3" })).rejects.toThrow(/已使用過/);
    // TOTP 秘密 DB 只存密文
    expect((await store.getOwnerUserById(a.user.id))!.totp_secret_enc).not.toContain(secret);
    // 第九批審查 L7：復原碼只存雜湊、每組只能用一次
    const fresh = (await store.getOwnerUserById(a.user.id))!;
    expect(fresh.totp_recovery_hashes).toHaveLength(8);
    expect(JSON.stringify(fresh.totp_recovery_hashes)).not.toContain(en.recoveryCodes[0]!);
    const r3 = await ownerLogin(a.d, { email: "t@example.com", password: "correct-horse-1", ip: "3.3.3.3" });
    if (r3.kind !== "mfa") throw new Error();
    expect((await ownerVerifyMfa(a.d, { ticket: r3.ticket, code: en.recoveryCodes[0]!.toUpperCase(), ip: "3.3.3.3" })).kind).toBe("session");
    const r4 = await ownerLogin(a.d, { email: "t@example.com", password: "correct-horse-1", ip: "3.3.3.3" });
    if (r4.kind !== "mfa") throw new Error();
    await expect(ownerVerifyMfa(a.d, { ticket: r4.ticket, code: en.recoveryCodes[0]!, ip: "3.3.3.3" })).rejects.toThrow(/已使用過/);
    expect((await store.getOwnerUserById(a.user.id))!.totp_recovery_hashes).toHaveLength(7);
    // 停用要密碼＋驗證碼
    await expect(disableTotp(store, a.user, totpCode(secret, Date.now() + 30_000), "nope")).rejects.toThrow(/密碼錯誤/);
  });

  it("L7：平台擁有者可重設店主的二步驟（要 confirm、寫稽核、登出所有裝置）；店主自己不行", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-totp-reset");
    const a = await onboard(store, shop.tenant, "lost@example.com", "owner");
    const { secret } = await beginTotpSetup(store, a.user, "correct-horse-1");
    await confirmTotpSetup(store, a.user, totpCode(secret), "correct-horse-1");
    await expect(adminResetTotp({ ...ctxFor(store), actor: ownerActor(a.user, a.m) }, { site: "own-totp-reset", membershipId: a.m.id, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(adminResetTotp(ctxFor(store), { site: "own-totp-reset", membershipId: a.m.id })).rejects.toMatchObject({ code: "confirm_required" });
    await adminResetTotp(ctxFor(store), { site: "own-totp-reset", membershipId: a.m.id, confirm: true });
    expect((await store.getOwnerUserById(a.user.id))!).toMatchObject({ totp_enabled_at: null, totp_recovery_hashes: [] });
    expect(await getOwnerSession(store, a.token)).toBeNull();
    expect((await store.listAudit(shop.tenant.id, 10)).some((x) => x.action === "owner.totp_admin_reset")).toBe(true);
  });
});

describe("第九批審查 L8／L9／L10", () => {
  it("L8：重新邀請把唯一的 owner 改成 editor → 拒絕", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-l8");
    const o = await onboard(store, shop.tenant, "solo@example.com", "owner");
    await expect(inviteOwnerInternal(o.d, shop.tenant, { email: "solo@example.com", role: "editor", by: "t" })).rejects.toThrow(/至少要有一位/);
  });

  it("L9：同一個 email 跨 IP 每小時超過 20 次 → 延遲（不鎖死；密碼對仍可登入）", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-l9");
    const a = await onboard(store, shop.tenant, "l9@example.com", "owner");
    const d = { ...a.d, slowdownMs: 120 };
    for (let i = 0; i < 20; i++) await expect(ownerLogin(d, { email: "l9@example.com", password: "nope-nope", ip: `10.0.${i}.1` })).rejects.toThrow(OWNER_LOGIN_FAILED);
    const t0 = Date.now();
    const ok = await ownerLogin(d, { email: "l9@example.com", password: "correct-horse-1", ip: "10.9.9.9" });
    expect(ok.kind).toBe("session");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it("L10：停用成員時列出並可一鍵撤銷他建立的手動 MCP token", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-l10");
    const o = await onboard(store, shop.tenant, "boss10@example.com", "owner");
    const o2 = await onboard(store, shop.tenant, "co10@example.com", "owner");
    const c2 = { ...ctxFor(store), actor: ownerActor(o2.user, o2.m) };
    const tok = await issueOwnerSiteToken(c2, { site: "own-l10", name: "co 的 Claude", scopes: ["site:read"] });
    expect((await store.getToken(tok.id))!.created_by).toBe(`owner-user:${o2.user.id}`);
    const c1 = { ...ctxFor(store), actor: ownerActor(o.user, o.m) };
    const r1 = await updateTeamMember(c1, { site: "own-l10", membershipId: o2.m.id, role: "editor" });
    expect(r1).toMatchObject({ memberTokens: 1, revokedTokens: 0 });
    const r2 = await updateTeamMember(c1, { site: "own-l10", membershipId: o2.m.id, status: "disabled", confirm: true, revokeTokens: true });
    expect(r2).toMatchObject({ memberTokens: 1, revokedTokens: 1 });
    expect(await authenticateBearer(store, `Bearer ${tok.token}`)).toBeNull();
  });
});

describe("角色權限與租戶隔離", () => {
  it("viewer 只能讀：改內容、建商品一律 forbidden；讀網站、訂單可以", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-role");
    const v = await onboard(store, shop.tenant, "v@example.com", "viewer");
    const ctx = { ...ctxFor(store), actor: ownerActor(v.user, v.m) };
    expect((await getSite(ctx, "own-role")).slug).toBe("own-role");
    await expect(listOrders(ctx, { site: "own-role" })).resolves.toBeTruthy();
    const site = await getSite(ctx, "own-role");
    const sec = site.pages[0]!.sections[0];
    if (sec) await expect(updateSection(ctx, { site: "own-role", path: "/", sectionId: sec.id, props: { heading: "x" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createProduct(ctx, { site: "own-role", slug: "p2", name: "x", price: 100 })).rejects.toMatchObject({ code: "forbidden" });
    expect(scopesForRole("viewer").some((s) => /write|publish|adjust/.test(s))).toBe(false);
  });

  it("editor 可以改內容，但不能改金流憑證、網域、成員、MCP token；owner 都可以", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-ed");
    const e = await onboard(store, shop.tenant, "e@example.com", "editor");
    const o = await onboard(store, shop.tenant, "o@example.com", "owner");
    const ectx = { ...ctxFor(store), actor: ownerActor(e.user, e.m) };
    const octx = { ...ctxFor(store), actor: ownerActor(o.user, o.m) };
    await expect(createProduct(ectx, { site: "own-ed", slug: "e1", name: "編輯建的", price: 100 })).resolves.toMatchObject({ slug: "e1" });
    await expect(saveProviderAccount(ectx, { site: "own-ed", provider: "pchomepay", appId: "APPID", secrets: { secret: "test-secret-0123" }, sandbox: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(addDomain(ectx, { site: "own-ed", domain: "x.own.test" }, createMockDomainAdapter())).rejects.toMatchObject({ code: "forbidden" });
    await expect(inviteTeamMember(ectx, { site: "own-ed", email: "n@example.com", role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(issueOwnerSiteToken(ectx, { site: "own-ed", name: "x", scopes: ["site:read"] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveProviderAccount(octx, { site: "own-ed", provider: "pchomepay", appId: "APPID12345", secrets: { secret: "test-secret-0123" }, sandbox: true })).resolves.toBeTruthy();
    const tok = await issueOwnerSiteToken(octx, { site: "own-ed", name: "我的 Claude", scopes: ["site:read", "content:write"] });
    expect((await authenticateBearer(store, `Bearer ${tok.token}`))!).toMatchObject({ tenantId: shop.tenant.id, scopes: ["site:read", "content:write"] });
    await expect(issueOwnerSiteToken(octx, { site: "own-ed", name: "x", scopes: ["platform:sites"] })).rejects.toMatchObject({ code: "invalid" });
    await revokeOwnerSiteToken(octx, { site: "own-ed", tokenId: tok.id });
    expect(await authenticateBearer(store, `Bearer ${tok.token}`)).toBeNull();
    await inviteTeamMember(octx, { site: "own-ed", email: "n@example.com", role: "viewer" });
    expect((await listTeam(octx, { site: "own-ed" })).members.map((m) => m.email).sort()).toEqual(["e@example.com", "n@example.com", "o@example.com"]);
  });

  it("跨租戶：A 網站的 owner 不能讀寫 B 網站（連 token 撤銷也不行）", async () => {
    const store = newStore();
    const a = await makeShop(store, "own-x-a");
    await createSite(ctxFor(store), { slug: "own-x-b", name: "B" });
    const b = (await store.getTenantBySlug("own-x-b"))!;
    const o = await onboard(store, a.tenant, "xa@example.com", "owner");
    const ctx = { ...ctxFor(store), actor: ownerActor(o.user, o.m) };
    await expect(getSite(ctx, "own-x-b")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listTeam(ctx, { site: "own-x-b" })).rejects.toMatchObject({ code: "forbidden" });
    const bTok = await store.insertToken({ tenant_id: b.id, name: "b", token_hash: "h".repeat(64), token_prefix: "gbt_xxxx", scopes: ["site:read"] });
    await expect(revokeOwnerSiteToken(ctx, { tokenId: bTok.id })).rejects.toMatchObject({ code: "not_found" });
    // 成員資格只對自己的網站有效
    expect(await store.getTenantUser(b.id, o.user.id)).toBeNull();
  });

  it("成員管理：停用需 confirm；至少保留一位啟用中的 owner；邀請中的不能直接啟用", async () => {
    const store = newStore();
    const shop = await makeShop(store, "own-team");
    const o = await onboard(store, shop.tenant, "own@example.com", "owner");
    const ctx = { ...ctxFor(store), actor: ownerActor(o.user, o.m) };
    await expect(updateTeamMember(ctx, { site: "own-team", membershipId: o.m.id, role: "editor" })).rejects.toThrow(/至少要有一位/);
    await expect(updateTeamMember(ctx, { site: "own-team", membershipId: o.m.id, status: "disabled", confirm: true })).rejects.toThrow(/至少要有一位/);
    const inv = await inviteTeamMember(ctx, { site: "own-team", email: "new@example.com", role: "editor" });
    await expect(updateTeamMember(ctx, { site: "own-team", membershipId: inv.membershipId, status: "active" })).rejects.toThrow(/還沒接受邀請/);
    const e = await onboard(store, shop.tenant, "ed2@example.com", "editor");
    await expect(updateTeamMember(ctx, { site: "own-team", membershipId: e.m.id, status: "disabled" })).rejects.toMatchObject({ code: "confirm_required" });
    await updateTeamMember(ctx, { site: "own-team", membershipId: e.m.id, status: "disabled", confirm: true });
    expect((await store.getTenantUser(shop.tenant.id, e.user.id))!.status).toBe("disabled");
  });
});

describe("店主後台與平台後台共用頁面", () => {
  it("每個 /admin/t/[slug] 頁面與 /api/admin/tenants/[slug] route 都有 /owner 對應（re-export 同一支），且 route 不再直接用 adminContext", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (dir: string, name: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), name) : e.name === name ? [path.join(dir, e.name)] : []));
    for (const [adm, own, file] of [["app/admin/t/[slug]", "app/owner/t/[slug]", "page.tsx"], ["app/api/admin/tenants/[slug]", "app/api/owner/tenants/[slug]", "route.ts"]] as const) {
      for (const p of walk(adm, file)) {
        const rel = path.relative(adm, p);
        const o = path.join(own, rel);
        expect(fs.existsSync(o), o).toBe(true);
        expect(fs.readFileSync(o, "utf8")).toContain(`${adm.replace("app/", "@/app/")}/${rel.replace(/\.tsx?$/, "")}`);
        if (file === "route.ts") expect(fs.readFileSync(p, "utf8"), p).not.toMatch(/adminContext|isAdmin\(/);
        else expect(fs.readFileSync(p, "utf8"), p).toContain("requireBackoffice");
      }
    }
  });
});
