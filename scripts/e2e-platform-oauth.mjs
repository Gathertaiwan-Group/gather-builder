/**
 * e2e-platform 的 OAuth 部分（由 scripts/e2e-platform.mjs 呼叫，用同一個店主帳號 session）：
 * MCP 官方 SDK client（StreamableHTTPClientTransport＋OAuthClientProvider）：
 *   401 → 發現（PRM → AS metadata）→ 動態註冊 → 授權（腳本模擬店主同意）→ 換 token → get_site → access 過期自動 refresh → 撤銷 → 401
 * 另驗：既有手動 Bearer token 帶上來直接 200、不觸發 OAuth。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

function memoryProvider(redirectUrl) {
  const st = { client: undefined, tokens: undefined, verifier: "", authUrl: null, savedTokens: 0 };
  return {
    st,
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return { client_name: "e2e MCP SDK client", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" };
    },
    state: () => "e2e-state-1",
    clientInformation: () => st.client,
    saveClientInformation: (c) => void (st.client = c),
    tokens: () => st.tokens,
    saveTokens: (t) => {
      st.tokens = t;
      st.savedTokens++;
    },
    redirectToAuthorization: (u) => void (st.authUrl = new URL(u)),
    saveCodeVerifier: (v) => void (st.verifier = v),
    codeVerifier: () => st.verifier,
  };
}

const hidden = (html) => {
  const out = [];
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) out.push([m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")]);
  return out;
};

export async function runOAuthPart({ base, slug, ok, req, jar, rest }) {
  const mcpUrl = new URL(`${base}/api/mcp`);
  /* 發現 */
  const prm = JSON.parse((await req("/.well-known/oauth-protected-resource/api/mcp")).text);
  ok("PRM（RFC 9728）：resource＝MCP 端點、authorization_servers＝平台", prm.resource === `${base}/api/mcp` && prm.authorization_servers?.[0] === base);
  const asm = JSON.parse((await req("/.well-known/oauth-authorization-server")).text);
  ok("AS metadata（RFC 8414）：S256、DCR、CIMD", asm.issuer === base && asm.code_challenge_methods_supported?.join() === "S256" && !!asm.registration_endpoint && asm.client_id_metadata_document_supported === true);
  const r401 = await req("/api/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }, headers: { accept: "application/json, text/event-stream" }, noCookies: true });
  ok("沒帶 token → 401＋WWW-Authenticate resource_metadata", r401.status === 401 && /resource_metadata="[^"]+oauth-protected-resource\/api\/mcp"/.test(r401.headers.get("www-authenticate") ?? ""));

  /* SDK：401 → 發現 → 註冊 → 導去授權 */
  const provider = memoryProvider("http://127.0.0.1:53682/callback");
  const t1 = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  const c1 = new Client({ name: "e2e-oauth", version: "1.0.0" });
  let unauthorized = false;
  try {
    await c1.connect(t1);
  } catch (e) {
    unauthorized = e instanceof UnauthorizedError;
  }
  const au = provider.st.authUrl;
  ok("SDK：401 → 發現 → 動態註冊（RFC 7591）→ 導去授權頁", unauthorized && !!provider.st.client?.client_id?.startsWith("gbc_") && !!au && au.pathname === "/oauth/authorize");
  ok("授權請求帶 PKCE S256＋resource＋state", au?.searchParams.get("code_challenge_method") === "S256" && au?.searchParams.get("resource") === `${base}/api/mcp` && au?.searchParams.get("state") === "e2e-state-1");

  /* 腳本模擬店主登入（e2e-platform 已登入，cookie 在 jar）與同意 */
  const consent = await req(`${au.pathname}${au.search}`);
  ok("同意畫面（店主已登入）", consent.status === 200 && consent.text.includes("e2e MCP SDK client") && consent.text.includes('data-oauth="consent"'), `HTTP ${consent.status}`);
  const tenantId = /<input[^>]*name="tenant_id"[^>]*value="([^"]+)"/.exec(consent.text)?.[1];
  if (!tenantId) console.log((/<input[^>]*tenant_id[^>]*>/.exec(consent.text) ?? ["(no radio)"])[0]);
  const form = new URLSearchParams(hidden(consent.text));
  form.set("tenant_id", tenantId);
  form.set("decision", "approve");
  for (const sc of ["site:read", "content:write", "publish"]) form.append("grant_scope", sc);
  const noCsrf = await req("/oauth/authorize/decision", { method: "POST", form: Object.fromEntries([...form].filter(([k]) => k !== "csrf")) });
  ok("同意表單缺 CSRF token → 400", noCsrf.status === 400);
  const decision = await fetch(`${base}/oauth/authorize/decision`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, body: form.toString() });
  const loc = new URL(decision.headers.get("location") ?? "http://x/");
  ok("同意 → 303 回 redirect_uri（帶 code、state、iss）", decision.status === 303 && loc.origin === "http://127.0.0.1:53682" && !!loc.searchParams.get("code") && loc.searchParams.get("state") === "e2e-state-1" && loc.searchParams.get("iss") === base);

  /* 換 token → 呼叫工具 */
  await t1.finishAuth(loc.searchParams.get("code"));
  ok("換到 access／refresh token", provider.st.tokens?.access_token?.startsWith("gboa_") && provider.st.tokens?.refresh_token?.startsWith("gbor_"));
  const c2 = new Client({ name: "e2e-oauth", version: "1.0.0" });
  await c2.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  const site = await c2.callTool({ name: "get_site", arguments: {} });
  ok("用 OAuth token 呼叫 get_site（綁授權的網站）", !site.isError && JSON.stringify(site.content).includes(slug));
  const forbidden = await c2.callTool({ name: "list_orders", arguments: {} });
  ok("沒授權的 scope（orders:read）被拒", forbidden.isError === true && JSON.stringify(forbidden.content).includes("forbidden"));

  /* access token 過期 → SDK 自動 refresh（輪替） */
  const oldRefresh = provider.st.tokens.refresh_token;
  const grants = await rest(`builder_oauth_grants?select=id&revoked_at=is.null&client_id=eq.${encodeURIComponent(provider.st.client.client_id)}`);
  await rest(`builder_oauth_tokens?grant_id=eq.${grants[0].id}&kind=eq.access`, { method: "PATCH", body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }), headers: { prefer: "return=minimal" } });
  const c3 = new Client({ name: "e2e-oauth", version: "1.0.0" });
  await c3.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  const again = await c3.callTool({ name: "get_site", arguments: {} });
  ok("access 過期 → SDK 自動 refresh 後成功、refresh token 已輪替", !again.isError && provider.st.tokens.refresh_token !== oldRefresh);

  /* 撤銷 → 401 */
  const rv = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: provider.st.tokens.refresh_token, client_id: provider.st.client.client_id }).toString() });
  ok("撤銷端點（RFC 7009）200", rv.status === 200);
  const after = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${provider.st.tokens.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) });
  ok("撤銷後 access token → 401（invalid_token）", after.status === 401 && (after.headers.get("www-authenticate") ?? "").includes("invalid_token"));
  const reuse = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: oldRefresh, client_id: provider.st.client.client_id }).toString() });
  ok("已輪替的舊 refresh token → invalid_grant", reuse.status === 400 && (await reuse.json()).error === "invalid_grant");

  /* 既有手動 Bearer token（店主後台發行）仍可用、不觸發 OAuth */
  const issue = await req(`/api/owner/tenants/${slug}/site-tokens`, { method: "POST", form: { action: "issue", name: "e2e 手動 token", scopes: "site:read" } });
  const tok = jar.get("gb_flash");
  ok("店主後台發行手動 token", issue.status === 303 && !!tok?.startsWith("gbt_"));
  const plain = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }) });
  ok("手動 Bearer token → 200、沒有 WWW-Authenticate（不觸發 OAuth）", plain.status === 200 && plain.headers.get("www-authenticate") === null);
  const staticProvider = memoryProvider("http://127.0.0.1:53683/callback");
  const c4 = new Client({ name: "e2e-static", version: "1.0.0" });
  await c4.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${tok}` } }, authProvider: staticProvider }));
  const s4 = await c4.callTool({ name: "get_site", arguments: {} });
  ok("SDK client 帶手動 token（同時設了 authProvider）：get_site 成功、沒有走 OAuth（沒註冊、沒導去授權）", !s4.isError && JSON.stringify(s4.content).includes(slug) && !staticProvider.st.client && !staticProvider.st.authUrl);
  return 0;
}
