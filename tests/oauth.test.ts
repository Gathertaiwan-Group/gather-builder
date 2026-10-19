/**
 * 第九批（4）：MCP OAuth 2.1（規格 2026-07-28）。
 * - metadata（RFC 9728／8414）、DCR（RFC 7591）、CIMD（client_id 是 https 網址；SSRF 防護）。
 * - PKCE 必須且是 S256、redirect_uri 精確比對（loopback IP 的 port 例外）、授權碼一次性＋過期、重用撤銷。
 * - token 綁網站與 scopes、綁 resource（audience）、角色降級即時生效、refresh 輪替＋重用偵測、撤銷後失效。
 * - 既有手動 Bearer token 仍可用、不觸發 OAuth；沒帶 token 的 401 帶 resource_metadata。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { createSite } from "@/lib/services/sites";
import { handleMcp } from "@/lib/mcp/handler";
import { inviteOwnerInternal, ownerAcceptInvite } from "@/lib/services/owners";
import {
  OAuthError,
  approveAuthorization,
  authenticateOAuthAccess,
  authorizationServerMetadata,
  oauthConfig,
  protectedResourceMetadata,
  redirectMatches,
  registerClient,
  resolveClient,
  revokeEndpoint,
  tokenEndpoint,
  validateAuthorize,
  validRedirectUri,
} from "@/lib/services/oauth";
import { listOAuthGrantsForTenant, revokeOAuthGrantForTenant } from "@/lib/services/oauth-grants";
import { ownerActor } from "@/lib/services/owners";
import type { Store, TenantRow, OwnerUserRow } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
});

const cfg = oauthConfig("http://test.local");
const REDIRECT = "http://localhost:33418/callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const params = (o: Record<string, string>) => new URLSearchParams(o);

async function setup(store: Store, role: "owner" | "editor" | "viewer" = "owner") {
  const shop = await makeShop(store, `oa-${role}-${Math.random().toString(36).slice(2, 7)}`);
  const sent: string[] = [];
  const d = { store, ipSecret: "x", baseUrl: "http://test.local", sendMail: async (_t: string, _s: string, text: string) => void sent.push(text) };
  const email = `${role}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await inviteOwnerInternal(d, shop.tenant, { email, role, by: "t" });
  const tok = decodeURIComponent(/owner\/invite\?t=(\S+)/.exec(sent[0]!)![1]!);
  await ownerAcceptInvite(d, { token: tok, password: "correct-horse-1", ip: "1.1.1.1" });
  const user = (await store.getOwnerUserByEmail(email))!;
  const client = await registerClient(store, { redirect_uris: [REDIRECT], client_name: "Test MCP Client", token_endpoint_auth_method: "none" }, { ipHash: "h" });
  return { tenant: shop.tenant, user, client, shop };
}

async function authorize(store: Store, s: { tenant: TenantRow; user: OwnerUserRow; client: { client_id: string } }, extra: Record<string, string> = {}, scopes?: string[]) {
  const { verifier, challenge } = pkce();
  const v = await validateAuthorize(store, cfg, params({ response_type: "code", client_id: s.client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", scope: "site:read content:write publish", resource: cfg.resource, ...extra }));
  if (!v.ok) throw v.error;
  const r = await approveAuthorization(store, cfg, { user: s.user, tenantId: s.tenant.id, req: v.req, scopes: scopes ?? v.req.scopes });
  const u = new URL(r.redirect);
  return { code: u.searchParams.get("code")!, verifier, redirect: u, grantId: r.grantId };
}

const exchange = (store: Store, clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
  tokenEndpoint(store, cfg, params({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: cfg.resource, ...extra }), null);

describe("metadata 與註冊", () => {
  it("Protected Resource Metadata＋Authorization Server Metadata（S256、DCR、CIMD、iss）", () => {
    expect(protectedResourceMetadata(cfg)).toMatchObject({ resource: "http://test.local/api/mcp", authorization_servers: ["http://test.local"], bearer_methods_supported: ["header"] });
    expect(protectedResourceMetadata(cfg).scopes_supported).not.toContain("platform:sites");
    expect(authorizationServerMetadata(cfg)).toMatchObject({
      issuer: "http://test.local",
      code_challenge_methods_supported: ["S256"],
      registration_endpoint: "http://test.local/oauth/register",
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("DCR：redirect_uri 只接受 https、loopback http、原生 scheme；只收 public client", async () => {
    const store = newStore();
    for (const bad of [["http://evil.example/cb"], ["javascript:alert(1)"], ["https://a.example/cb#frag"], []]) {
      await expect(registerClient(store, { redirect_uris: bad }, { ipHash: "h" })).rejects.toBeInstanceOf(OAuthError);
    }
    await expect(registerClient(store, { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" }, { ipHash: "h" })).rejects.toMatchObject({ error: "invalid_client_metadata" });
    const ok = await registerClient(store, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:8080/cb", "com.example.app:/oauth"], client_name: "Claude" }, { ipHash: "h" });
    expect(ok.client_id).toMatch(/^gbc_/);
    expect(validRedirectUri("http://[::1]:9/x")).toBe(true);
  });

  it("CIMD：https client_id 取回文件、client_id 必須相符、內部位址拒絕（SSRF）", async () => {
    const store = newStore();
    const id = "https://client.example/oauth/metadata.json";
    const doc = { client_id: id, client_name: "Example MCP Client", redirect_uris: ["http://localhost:3000/callback"], token_endpoint_auth_method: "none" };
    const fetcher = async () => ({ ok: true, status: 200, contentType: "application/json", text: JSON.stringify(doc) });
    const c = await resolveClient(store, id, { fetcher, resolver: async () => ["93.184.216.34"] });
    expect(c).toMatchObject({ kind: "cimd", client_name: "Example MCP Client" });
    await expect(resolveClient(store, "https://other.example/m.json", { fetcher, resolver: async () => ["93.184.216.34"] })).rejects.toThrow(/完全相同/);
    await expect(resolveClient(store, "https://intranet.example/m.json", { fetcher, resolver: async () => ["10.0.0.5"] })).rejects.toThrow(/內部位址/);
    await expect(resolveClient(store, "https://127.0.0.1/m.json", { fetcher })).rejects.toThrow(/內部位址/);
    await expect(resolveClient(store, "https://metadata.example/m.json", { fetcher, resolver: async () => ["169.254.169.254"] })).rejects.toThrow(/內部位址/);
    await expect(resolveClient(store, "not-registered")).rejects.toMatchObject({ error: "invalid_client" });
  });
});

describe("授權請求驗證", () => {
  it("PKCE 必須且只接受 S256；resource 不對拒絕；這些錯誤導回 client 並帶 iss", async () => {
    const store = newStore();
    const s = await setup(store);
    const base = { response_type: "code", client_id: s.client.client_id, redirect_uri: REDIRECT, state: "abc" };
    const noPkce = await validateAuthorize(store, cfg, params(base));
    expect(noPkce.ok).toBe(false);
    if (!noPkce.ok) {
      const u = new URL(noPkce.redirect!);
      expect(u.searchParams.get("error")).toBe("invalid_request");
      expect(u.searchParams.get("state")).toBe("abc");
      expect(u.searchParams.get("iss")).toBe("http://test.local");
    }
    const plain = await validateAuthorize(store, cfg, params({ ...base, code_challenge: "a".repeat(43), code_challenge_method: "plain" }));
    expect(plain.ok).toBe(false);
    const res = await validateAuthorize(store, cfg, params({ ...base, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "https://evil.example/mcp" }));
    expect(!res.ok && new URL(res.redirect!).searchParams.get("error")).toBe("invalid_target");
    const good = await validateAuthorize(store, cfg, params({ ...base, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "HTTP://TEST.LOCAL/api/mcp/" }));
    expect(good.ok).toBe(true);
  });

  it("redirect_uri 精確比對：路徑、query、host、scheme、localhost 的 port 不同都拒絕且不導回；loopback IP 的 port 可變（OAuth 2.1 §8.4.2）", async () => {
    const store = newStore();
    const s = await setup(store);
    for (const r of ["http://localhost:33418/callback/x", "http://localhost:33418/callback?x=1", "http://evil.example:33418/callback", "https://localhost:33418/callback", "http://localhost:9999/callback"]) {
      const v = await validateAuthorize(store, cfg, params({ response_type: "code", client_id: s.client.client_id, redirect_uri: r, code_challenge: pkce().challenge, code_challenge_method: "S256" }));
      expect(v.ok, r).toBe(false);
      if (!v.ok) expect(v.redirect, r).toBeNull();
    }
    expect(redirectMatches(["http://127.0.0.1:5000/cb"], "http://127.0.0.1:61234/cb")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1:5000/cb"], "http://127.0.0.1:61234/other")).toBe(false);
    const unknown = await validateAuthorize(store, cfg, params({ response_type: "code", client_id: "gbc_nope", redirect_uri: REDIRECT }));
    expect(!unknown.ok && unknown.redirect).toBeNull();
  });
});

describe("授權碼與 token", () => {
  it("完整流程：同意 → code（帶 state、iss）→ 錯的 verifier 拒絕 → 對的換到 token；token 綁網站與 scopes、綁 resource", async () => {
    const store = newStore();
    const s = await setup(store);
    const a = await authorize(store, s);
    expect(a.redirect.searchParams.get("state")).toBe("st-1");
    expect(a.redirect.searchParams.get("iss")).toBe("http://test.local");
    await expect(exchange(store, s.client.client_id, a.code, pkce().verifier)).rejects.toMatchObject({ error: "invalid_grant" });
    // 上面那次已用掉授權碼（一次性）→ 重新授權
    const b = await authorize(store, s);
    await expect(exchange(store, s.client.client_id, b.code, b.verifier, { redirect_uri: "http://localhost:33418/other" })).rejects.toMatchObject({ error: "invalid_grant" });
    const c = await authorize(store, s);
    await expect(exchange(store, "gbc_someone_else", c.code, c.verifier)).rejects.toMatchObject({ error: "invalid_grant" });
    const d = await authorize(store, s);
    const t = await exchange(store, s.client.client_id, d.code, d.verifier);
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(t.access_token).toMatch(/^gboa_/);
    expect(t.refresh_token).toMatch(/^gbor_/);
    const actor = (await authenticateOAuthAccess(store, t.access_token, cfg.resource))!;
    expect(actor).toMatchObject({ kind: "token", tenantId: s.tenant.id });
    expect(actor.scopes.sort()).toEqual(["content:write", "publish", "site:read"]);
    // audience：別的 resource 不收
    expect(await authenticateOAuthAccess(store, t.access_token, "https://other.example/api/mcp")).toBeNull();
    // DB 只存雜湊
    expect(JSON.stringify(await store.getOAuthTokenByHash(createHash("sha256").update(t.access_token).digest("hex")))).not.toContain(t.access_token);
  });

  it("授權碼一次性：重用 → invalid_grant 並撤銷用它換到的 token；過期拒絕", async () => {
    const store = newStore();
    const s = await setup(store);
    const a = await authorize(store, s);
    const t = await exchange(store, s.client.client_id, a.code, a.verifier);
    await expect(exchange(store, s.client.client_id, a.code, a.verifier)).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await authenticateOAuthAccess(store, t.access_token, cfg.resource)).toBeNull();
    expect((await store.getOAuthGrant(a.grantId))!.revoked_reason).toBe("code_reuse");
    const b = await authorize(store, s);
    const row = (await store.getOAuthCodeByHash(createHash("sha256").update(b.code).digest("hex")))!;
    (row as { expires_at: string }).expires_at = new Date(Date.now() - 1000).toISOString();
    const expired: Store = { ...store, consumeOAuthCode: async () => null, getOAuthCodeByHash: async () => row };
    await expect(exchange(expired, s.client.client_id, b.code, b.verifier)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("refresh：輪替（舊的不能再用）；舊的重用 → 整個授權撤銷、新 token 也失效", async () => {
    const store = newStore();
    const s = await setup(store);
    const a = await authorize(store, s);
    const t1 = await exchange(store, s.client.client_id, a.code, a.verifier);
    const t2 = await tokenEndpoint(store, cfg, params({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: s.client.client_id }), null);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(await authenticateOAuthAccess(store, t2.access_token, cfg.resource)).not.toBeNull();
    // 縮小 scope 可以、擴大不行
    const t3 = await tokenEndpoint(store, cfg, params({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: s.client.client_id, scope: "site:read" }), null);
    expect(t3.scope).toBe("site:read");
    // 重用已輪替的 refresh token
    await expect(tokenEndpoint(store, cfg, params({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: s.client.client_id }), null)).rejects.toMatchObject({ error: "invalid_grant" });
    expect((await store.getOAuthGrant(a.grantId))!.revoked_reason).toBe("refresh_reuse");
    expect(await authenticateOAuthAccess(store, t3.access_token, cfg.resource)).toBeNull();
    await expect(tokenEndpoint(store, cfg, params({ grant_type: "refresh_token", refresh_token: t3.refresh_token, client_id: s.client.client_id }), null)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("撤銷：client 撤銷 refresh → 授權失效；店主後台撤銷 → 立即 401；成員停用 → 立即失效；viewer 只拿到讀取 scope", async () => {
    const store = newStore();
    const s = await setup(store);
    const a = await authorize(store, s);
    const t = await exchange(store, s.client.client_id, a.code, a.verifier);
    await revokeEndpoint(store, params({ token: t.refresh_token, client_id: s.client.client_id }), null);
    expect(await authenticateOAuthAccess(store, t.access_token, cfg.resource)).toBeNull();
    // 店主後台撤銷
    const b = await authorize(store, s);
    const tb = await exchange(store, s.client.client_id, b.code, b.verifier);
    const m = (await store.getTenantUser(s.tenant.id, s.user.id))!;
    const octx = { ...ctxFor(store), actor: ownerActor(s.user, m) };
    expect((await listOAuthGrantsForTenant(octx, {})).find((g) => g.id === b.grantId)).toMatchObject({ clientName: "Test MCP Client", revokedAt: null });
    await revokeOAuthGrantForTenant(octx, { grantId: b.grantId });
    expect(await authenticateOAuthAccess(store, tb.access_token, cfg.resource)).toBeNull();
    // 成員停用
    const c = await authorize(store, s);
    const tc = await exchange(store, s.client.client_id, c.code, c.verifier);
    await store.updateTenantUser(s.tenant.id, m.id, { status: "disabled" });
    expect(await authenticateOAuthAccess(store, tc.access_token, cfg.resource)).toBeNull();
    // viewer：只能授權讀取權限
    const sv = await setup(store, "viewer");
    await expect(authorize(store, sv, {}, ["content:write", "publish"])).rejects.toMatchObject({ error: "invalid_scope" });
    const v = await authorize(store, sv);
    const tv = await exchange(store, sv.client.client_id, v.code, v.verifier);
    expect((await authenticateOAuthAccess(store, tv.access_token, cfg.resource))!.scopes).toEqual(["site:read"]);
  });

  it("跨租戶：不能把授權發到自己不是成員的網站", async () => {
    const store = newStore();
    const s = await setup(store);
    await createSite(ctxFor(store), { slug: "oa-other", name: "別人的" });
    const other = (await store.getTenantBySlug("oa-other"))!;
    await expect(authorize(store, { ...s, tenant: other })).rejects.toMatchObject({ error: "access_denied" });
  });
});

describe("MCP 端點：兩種 token 並存", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_site", arguments: {} } };
  const mcpReq = (token: string | null, body: unknown) =>
    new Request("http://test.local/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  it("既有手動 token → 直接 200（不回 401、不觸發 OAuth）；OAuth access token → get_site 是授權的那個網站；沒 token → 401＋resource_metadata", async () => {
    const store = newStore();
    const site = await createSite(ctxFor(store), { slug: "oa-static", name: "靜態" });
    const r1 = await handleMcp(mcpReq(site.token!, init), store);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("www-authenticate")).toBeNull();
    const s = await setup(store);
    const a = await authorize(store, s);
    const t = await exchange(store, s.client.client_id, a.code, a.verifier);
    const r2 = await handleMcp(mcpReq(t.access_token, call), store);
    expect(r2.status).toBe(200);
    expect(JSON.stringify(await r2.json())).toContain(s.tenant.slug);
    const r3 = await handleMcp(mcpReq(null, init), store);
    expect(r3.status).toBe(401);
    expect(r3.headers.get("www-authenticate")).toContain('resource_metadata="http://test.local/.well-known/oauth-protected-resource/api/mcp"');
    const r4 = await handleMcp(mcpReq(`gboa_${"A".repeat(43)}`, init), store);
    expect(r4.status).toBe(401);
    expect(r4.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
