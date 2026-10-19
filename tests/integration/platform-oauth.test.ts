/**
 * 整合測試（npm run test:db）：第九批（4）OAuth（migration 0041）在真 DB 上。
 * - 授權碼併發兌換 5 次只成功 1 次；refresh token 併發輪替 5 次只成功 1 次、其餘觸發重用偵測撤銷授權。
 * - 撤銷授權後 access token 立即失效；token 只存 sha256。
 * 建 is_test 租戶與 itest 帳號，跑完刪除。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { inviteOwnerInternal, ownerAcceptInvite } from "@/lib/services/owners";
import { approveAuthorization, authenticateOAuthAccess, oauthConfig, registerClient, tokenEndpoint, validateAuthorize } from "@/lib/services/oauth";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const ts = Date.now().toString(36);
const slug = `itoauth-${ts}`;
const email = `itoauth-${ts}@example.com`;

describe.skipIf(!enabled)("OAuth（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };
  const cfg = oauthConfig("https://itest.example");
  let clientId = "";

  afterAll(async () => {
    if (!enabled) return;
    await db.from("builder_tenants").delete().eq("slug", slug);
    await db.from("builder_owner_users").delete().eq("email", email);
    if (clientId) await db.from("builder_oauth_clients").delete().eq("client_id", clientId);
    expect((await db.from("builder_oauth_clients").select("id").eq("client_id", clientId)).data).toEqual([]);
  });

  it("授權碼／refresh 併發只成功一次、重用撤銷、撤銷後失效", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, test: true });
    const tenant = (await store.getTenantBySlug(slug))!;
    const sent: string[] = [];
    const deps = { store, ipSecret: "itest-ip", baseUrl: "https://itest.example", sendMail: async (_t: string, _s: string, text: string) => void sent.push(text) };
    await inviteOwnerInternal(deps, tenant, { email, role: "owner", by: "itest" });
    await ownerAcceptInvite(deps, { token: decodeURIComponent(/owner\/invite\?t=(\S+)/.exec(sent[0]!)![1]!), password: "itest-password-1", ip: "203.0.113.5" });
    const user = (await store.getOwnerUserByEmail(email))!;
    const c = await registerClient(store, { redirect_uris: ["http://127.0.0.1:7777/cb"], client_name: "itest client" }, { ipHash: "it" });
    clientId = c.client_id;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const v = await validateAuthorize(store, cfg, new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:7777/cb", code_challenge: challenge, code_challenge_method: "S256", scope: "site:read content:write", resource: cfg.resource }));
    if (!v.ok) throw v.error;
    const a = await approveAuthorization(store, cfg, { user, tenantId: tenant.id, req: v.req, scopes: v.req.scopes });
    const code = new URL(a.redirect).searchParams.get("code")!;
    const form = () => new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: "http://127.0.0.1:7777/cb" });
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => tokenEndpoint(store, cfg, form(), null)));
    const won = r.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof tokenEndpoint>>> => x.status === "fulfilled");
    expect(won).toHaveLength(1);
    // 失敗的那幾次是「重用」→ 授權被撤銷（用它換到的 token 也失效）——符合 OAuth 2.1 對授權碼重用的建議
    expect((await store.getOAuthGrant(a.grantId))!.revoked_reason).toBe("code_reuse");
    expect(await authenticateOAuthAccess(store, won[0]!.value.access_token, cfg.resource)).toBeNull();
    // 重新授權一次，測 refresh 併發
    const v2 = await validateAuthorize(store, cfg, new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:7777/cb", code_challenge: challenge, code_challenge_method: "S256", scope: "site:read", resource: cfg.resource }));
    if (!v2.ok) throw v2.error;
    const a2 = await approveAuthorization(store, cfg, { user, tenantId: tenant.id, req: v2.req, scopes: v2.req.scopes });
    const t = await tokenEndpoint(store, cfg, new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code: new URL(a2.redirect).searchParams.get("code")!, code_verifier: verifier, redirect_uri: "http://127.0.0.1:7777/cb" }), null);
    expect((await authenticateOAuthAccess(store, t.access_token, cfg.resource))!).toMatchObject({ tenantId: tenant.id, scopes: ["site:read"] });
    const rows = (await db.from("builder_oauth_tokens").select("token_hash").eq("grant_id", a2.grantId)).data!;
    expect(JSON.stringify(rows)).not.toContain(t.access_token);
    const rf = await Promise.allSettled(Array.from({ length: 5 }, () => tokenEndpoint(store, cfg, new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId }), null)));
    expect(rf.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await store.getOAuthGrant(a2.grantId))!.revoked_at).not.toBeNull();
    expect(await authenticateOAuthAccess(store, t.access_token, cfg.resource)).toBeNull();
  });
});
