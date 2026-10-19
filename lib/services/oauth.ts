import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { TENANT_SCOPES, isScope, type Scope } from "../scopes";
import type { Actor } from "../tokens";
import type { OAuthClientRow, OAuthGrantRow, OwnerUserRow, Store } from "../store/types";
import { scopesForRole } from "./owners";

/**
 * MCP Authorization（OAuth 2.1）——依 MCP 規格 2026-07-28
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
 *
 * - 資源伺服器：/api/mcp（canonical resource＝<平台網址>/api/mcp）。401 帶 WWW-Authenticate resource_metadata（RFC 9728）。
 * - 授權伺服器：issuer＝<平台網址>；metadata /.well-known/oauth-authorization-server（RFC 8414）。
 * - 用戶端註冊：Client ID Metadata Documents（https 網址當 client_id，SSRF 防護）與 Dynamic Client Registration（RFC 7591，向下相容）。只支援 public client（token_endpoint_auth_method=none）。
 * - authorization code＋PKCE（只接受 S256，沒帶就拒絕）；授權碼一次性、2 分鐘；重用 → 撤銷整個授權。
 * - access token 1 小時、綁 resource（audience）＋網站＋scopes，DB 只存 sha256；refresh token 30 天、每次使用就輪替，舊的再出現＝重用 → 撤銷整個授權。
 * - redirect_uri 精確比對（唯一例外：OAuth 2.1 §8.4.2 規定 loopback IP（127.0.0.1／[::1]）的 port 可變）。
 * - 回應帶 iss（RFC 9207）。🔴 token 原文不寫進 log。
 * - 手動 Bearer token（gbt_／gbp_）完全不受影響：authenticateBearer 先認得 token 前綴，OAuth 只處理 gboa_。
 */
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86400;
/** 第九批審查 M3：refresh token 的絕對壽命（從使用者同意算起），到期要重新授權 */
export const GRANT_MAX_AGE_S = 90 * 86400;
export const CODE_TTL_MS = 2 * 60_000;
export const SPEC_URL = "https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization";

export class OAuthError extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400,
  ) {
    super(description);
  }
  body() {
    return { error: this.error, error_description: this.description };
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");

export interface OAuthConfig {
  issuer: string;
  resource: string;
}

export function oauthConfig(baseUrl: string): OAuthConfig {
  const issuer = baseUrl.replace(/\/$/, "");
  return { issuer, resource: `${issuer}/api/mcp` };
}

/** RFC 8707 canonical：scheme／host 小寫、去掉結尾斜線、不可有 fragment */
export function normalizeResource(r: string): string | null {
  try {
    const u = new URL(r);
    if (u.hash) return null;
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

export function protectedResourceMetadata(cfg: OAuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: TENANT_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Gather Builder MCP",
    resource_documentation: `${cfg.issuer}/owner`,
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: TENANT_SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: SPEC_URL,
  };
}

/** 第九批審查 M4：401 只要求最小的讀取 scope；需要寫入時由 403 insufficient_scope 帶所需 scope 做 step-up */
export const MIN_SCOPES: Scope[] = ["site:read"];
/** 同意頁的危險權限（金流退款／取消、儲值金、點數、會員停用、發布上線） */
export const DANGEROUS_SCOPES: Scope[] = ["orders:write", "wallet:adjust", "points:adjust", "members:write", "publish"];

/** WWW-Authenticate（RFC 9728 §5.1／RFC 6750 §3） */
export function wwwAuthenticate(cfg: OAuthConfig, error?: "invalid_token" | "insufficient_scope", scopes: string[] = MIN_SCOPES) {
  const parts = [`resource_metadata="${cfg.issuer}/.well-known/oauth-protected-resource/api/mcp"`, `scope="${scopes.join(" ")}"`];
  if (error) parts.unshift(`error="${error}"`);
  // header 只能是 ASCII
  if (error === "insufficient_scope") parts.push(`error_description="this operation requires scope ${scopes.join(" ")}"`);
  return `Bearer ${parts.join(", ")}`;
}

/* ================================================================== redirect_uri */

const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);
const LOOPBACK_IP = new Set(["127.0.0.1", "[::1]"]);

export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (BAD_SCHEMES.has(u.protocol)) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return u.hostname === "localhost" || LOOPBACK_IP.has(u.hostname);
  // 原生 app 的私用 scheme（RFC 8252 §7.1）
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/** 精確比對；只有 loopback IP（127.0.0.1／[::1]）依 OAuth 2.1 §8.4.2 容許 port 不同 */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== "http:" || !LOOPBACK_IP.has(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const x = new URL(r);
      return x.protocol === "http:" && x.hostname === g.hostname && x.pathname === g.pathname && x.search === g.search;
    } catch {
      return false;
    }
  });
}

/* ================================================================== 用戶端：DCR＋CIMD */

export async function registerClient(store: Store, body: unknown, opts: { ipHash: string }) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) throw new OAuthError("invalid_redirect_uri", "redirect_uris 必填，且只接受 https、http://localhost／127.0.0.1／[::1]，或原生 app scheme（不可有 fragment）");
  const auth = b.token_endpoint_auth_method ?? "none";
  if (auth !== "none") throw new OAuthError("invalid_client_metadata", "只支援 public client（token_endpoint_auth_method=none）");
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code", "refresh_token"];
  if (!grants.every((g) => g === "authorization_code" || g === "refresh_token")) throw new OAuthError("invalid_client_metadata", "grant_types 只支援 authorization_code、refresh_token");
  const rts = Array.isArray(b.response_types) ? b.response_types : ["code"];
  if (!rts.every((r) => r === "code")) throw new OAuthError("invalid_client_metadata", "response_types 只支援 code");
  const name = typeof b.client_name === "string" ? b.client_name.trim().slice(0, 200) : null;
  const clientId = `gbc_${b64url(randomBytes(18))}`;
  const metadata = {
    client_name: name,
    client_uri: typeof b.client_uri === "string" ? b.client_uri.slice(0, 300) : undefined,
    application_type: b.application_type === "native" || b.application_type === "web" ? b.application_type : undefined,
    grant_types: grants,
    response_types: rts,
    token_endpoint_auth_method: "none",
    scope: typeof b.scope === "string" ? b.scope.slice(0, 1000) : undefined,
  };
  const row = await store.insertOAuthClient({ client_id: clientId, kind: "dcr", client_name: name, redirect_uris: uris as string[], metadata, created_ip_hash: opts.ipHash, fetched_at: null });
  return { client_id: row.client_id, client_id_issued_at: Math.floor(Date.parse(row.created_at) / 1000), redirect_uris: row.redirect_uris, ...metadata };
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^192\.0\.2\./, /^198\.(1[89])\./, /^198\.51\.100\./, /^203\.0\.113\./, /^(22[4-9]|2[3-5]\d)\./];

/** 把 IPv6 展開成 8 組 16 進位（支援 :: 與結尾內嵌 IPv4） */
function expandV6(a: string): number[] | null {
  let s = a.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":").filter(Boolean) : [];
  const t = tail ? tail.split(":").filter(Boolean) : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  if (fill < 0) return null;
  const all = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isFinite(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/**
 * 第九批審查 L5：不可連的位址（私網、loopback、link-local、保留段；IPv6 含 ::/96 IPv4-compatible、::ffff:0:0/96 mapped、
 * 64:ff9b::/96 NAT64、2002::/16 6to4、fc00::/7 ULA、fe80::/10、ff00::/8 multicast、2001:db8::/32 文件用）
 */
export function privateAddress(addr: string): boolean {
  if (isIP(addr) === 4) return PRIVATE_V4.some((r) => r.test(addr));
  const g = expandV6(addr);
  if (!g) return true;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::/96（含 ::、::1、IPv4-compatible）
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true; // ::ffff:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true; // 64:ff9b::/96
  if (g[0] === 0x2002) return true; // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 文件用
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true; // 2001::/23 IETF 協定保留（含 Teredo 2001::/32）
  return false;
}

export type CimdFetcher = (url: string) => Promise<{ ok: boolean; status: number; contentType: string; text: string }>;
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) => (await dnsLookup(host, { all: true })).map((x) => x.address);

/**
 * 第九批審查 L5：用「檢查過的那個 IP」直接連線（https.request 的 lookup 只回傳檢查過的位址；SNI／Host 仍是原本的主機名），
 * 消除「檢查時解析一次、連線時又解析一次」的 DNS rebinding 時間差。不跟隨轉址、5 秒、16KB。
 */
function pinnedFetcher(resolver: HostResolver): CimdFetcher {
  return async (url) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : await resolver(host);
    const ip = addrs.find((a) => !privateAddress(a));
    if (!ip || addrs.some(privateAddress)) throw new Error("private");
    const { request } = await import("node:https");
    return await new Promise((resolve, reject) => {
      const r = request(
        { protocol: "https:", hostname: u.hostname, servername: isIP(host) ? undefined : host, port: u.port || 443, path: `${u.pathname}${u.search}`, method: "GET", headers: { accept: "application/json" }, timeout: 5000, lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, ip, isIP(ip)) },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 16_384) {
              r.destroy(new Error("too large"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      r.on("timeout", () => r.destroy(new Error("timeout")));
      r.on("error", reject);
      r.end();
    });
  };
}

/** CIMD（draft-ietf-oauth-client-id-metadata-document-00）：client_id 是 https 網址（要有路徑）→ 取回文件驗證；24 小時快取 */
export function isCimdClientId(id: string): boolean {
  try {
    const u = new URL(id);
    return u.protocol === "https:" && u.pathname.length > 1 && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

export async function resolveClient(store: Store, clientId: string, deps: { fetcher?: CimdFetcher; resolver?: HostResolver; beforeFetch?: () => Promise<void> } = {}): Promise<OAuthClientRow> {
  if (typeof clientId !== "string" || !clientId || clientId.length > 500) throw new OAuthError("invalid_client", "缺少 client_id", 401);
  const existing = await store.getOAuthClient(clientId);
  if (existing?.disabled_at) throw new OAuthError("invalid_client", "這個 client 已被停用", 401);
  if (existing && (existing.kind === "dcr" || (existing.fetched_at && Date.parse(existing.fetched_at) > Date.now() - 86400_000))) return existing;
  if (!isCimdClientId(clientId)) throw new OAuthError("invalid_client", "未知的 client_id（請先註冊，或使用 https 網址的 Client ID Metadata Document）", 401);
  const u = new URL(clientId);
  // 🔴 SSRF：只連公開位址（IP 字面值與 DNS 解析結果都要檢查；不跟隨轉址、5 秒、16KB）
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const resolver = deps.resolver ?? defaultResolver;
  const addrs = isIP(host) ? [host] : await resolver(host).catch(() => []);
  if (!addrs.length || addrs.some(privateAddress)) throw new OAuthError("invalid_client", "client metadata 文件的網址不能是內部位址", 401);
  // 第九批審查 L5：抓取外部文件要限流（由呼叫端注入，例如每 IP 每 10 分鐘次數）
  if (deps.beforeFetch) await deps.beforeFetch();
  let doc: Record<string, unknown>;
  try {
    const r = await (deps.fetcher ?? pinnedFetcher(resolver))(clientId);
    if (!r.ok || !/json/i.test(r.contentType)) throw new Error("bad");
    doc = JSON.parse(r.text) as Record<string, unknown>;
  } catch {
    // 🔴 不回傳對方的回應內容或錯誤細節（避免被拿來探測內部服務）
    throw new OAuthError("invalid_client", "無法取得或解析 client metadata 文件", 401);
  }
  if (doc.client_id !== clientId) throw new OAuthError("invalid_client", "client metadata 文件的 client_id 必須與網址完全相同", 401);
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) throw new OAuthError("invalid_client", "client metadata 文件的 redirect_uris 不合法", 401);
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) throw new OAuthError("invalid_client", "client metadata 文件缺少 client_name", 401);
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none") throw new OAuthError("invalid_client", "只支援 public client（token_endpoint_auth_method=none）", 401);
  const meta = { client_name: doc.client_name.slice(0, 200), client_uri: typeof doc.client_uri === "string" ? doc.client_uri.slice(0, 300) : undefined };
  const nowIso = new Date().toISOString();
  if (existing) {
    await store.updateOAuthClient(clientId, { client_name: meta.client_name, redirect_uris: uris as string[], metadata: meta, fetched_at: nowIso });
    return { ...existing, client_name: meta.client_name, redirect_uris: uris as string[], metadata: meta, fetched_at: nowIso };
  }
  try {
    return await store.insertOAuthClient({ client_id: clientId, kind: "cimd", client_name: meta.client_name, redirect_uris: uris as string[], metadata: meta, created_ip_hash: null, fetched_at: nowIso });
  } catch {
    return (await store.getOAuthClient(clientId))!;
  }
}

/* ================================================================== 授權端點 */

export interface AuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  /** 請求有沒有帶 redirect_uri（L13） */
  redirectExplicit: boolean;
  state: string | null;
  codeChallenge: string;
  scopes: Scope[];
  resource: string;
}

export function parseScopes(raw: unknown): Scope[] {
  const list = typeof raw === "string" ? raw.split(/\s+/).filter(Boolean) : [];
  // 第九批審查 M4：沒帶 scope → 最小權限（不是全部）
  if (!list.length) return [...MIN_SCOPES];
  return [...new Set(list.filter((s): s is Scope => isScope(s) && (TENANT_SCOPES as string[]).includes(s)))];
}

/**
 * 驗證授權請求。🔴 client 或 redirect_uri 不對 → 絕不導回（直接顯示錯誤，防 open redirect）；
 * 其他錯誤（缺 PKCE、不支援的 response_type、resource 不對）→ 帶 error 導回 redirect_uri。
 */
export async function validateAuthorize(store: Store, cfg: OAuthConfig, p: URLSearchParams, deps: { fetcher?: CimdFetcher; resolver?: HostResolver; beforeFetch?: () => Promise<void> } = {}): Promise<{ ok: true; req: AuthorizeRequest } | { ok: false; redirect: string | null; error: OAuthError }> {
  let client: OAuthClientRow;
  try {
    client = await resolveClient(store, p.get("client_id") ?? "", deps);
  } catch (e) {
    return { ok: false, redirect: null, error: e instanceof OAuthError ? e : new OAuthError("invalid_client", "client 錯誤") };
  }
  const redirectUri = p.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : "");
  if (!redirectUri || !redirectMatches(client.redirect_uris, redirectUri)) return { ok: false, redirect: null, error: new OAuthError("invalid_request", "redirect_uri 與註冊的不符") };
  const state = p.get("state");
  const back = (e: OAuthError) => ({ ok: false as const, redirect: errorRedirect(cfg, redirectUri, e, state), error: e });
  if (p.get("response_type") !== "code") return back(new OAuthError("unsupported_response_type", "只支援 response_type=code"));
  const challenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back(new OAuthError("invalid_request", "必須使用 PKCE：code_challenge（43 字 base64url）＋ code_challenge_method=S256"));
  const resRaw = p.get("resource");
  const resource = resRaw ? normalizeResource(resRaw) : cfg.resource;
  if (!resource || resource !== normalizeResource(cfg.resource)) return back(new OAuthError("invalid_target", `resource 必須是 ${cfg.resource}`));
  const scopes = parseScopes(p.get("scope"));
  if (!scopes.length) return back(new OAuthError("invalid_scope", "沒有可授權的 scope"));
  return { ok: true, req: { client, redirectUri, redirectExplicit: p.get("redirect_uri") !== null, state, codeChallenge: challenge, scopes, resource: cfg.resource } };
}

export function errorRedirect(cfg: OAuthConfig, redirectUri: string, e: OAuthError, state: string | null) {
  const u = new URL(redirectUri);
  u.searchParams.set("error", e.error);
  u.searchParams.set("error_description", e.description.slice(0, 200));
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", cfg.issuer);
  return u.toString();
}

/** 店主同意：建立授權（同意紀錄）＋一次性授權碼 → 導回 client（帶 code、state、iss） */
export async function approveAuthorization(store: Store, cfg: OAuthConfig, input: { user: OwnerUserRow; tenantId: string; req: AuthorizeRequest; scopes: string[] }) {
  const m = await store.getTenantUser(input.tenantId, input.user.id);
  if (!m || m.status !== "active" || input.user.status !== "active") throw new OAuthError("access_denied", "你不是這個網站的啟用中成員");
  const allowed = new Set(scopesForRole(m.role));
  // 授權＝店主在同意頁勾選的（可以比 client 請求的多或少；token 回應的 scope 會告訴 client 實際拿到什麼）∩ 角色允許
  const scopes = [...new Set(input.scopes)].filter((s): s is Scope => (TENANT_SCOPES as string[]).includes(s) && allowed.has(s as Scope));
  if (!scopes.length) throw new OAuthError("invalid_scope", "至少要授權一個 scope（檢視者只能授權讀取權限）");
  const grant = await store.insertOAuthGrant({ client_id: input.req.client.client_id, user_id: input.user.id, tenant_id: input.tenantId, scopes, resource: input.req.resource });
  const code = `gbac_${b64url(randomBytes(32))}`;
  await store.insertOAuthCode({ code_hash: sha256(code), grant_id: grant.id, client_id: input.req.client.client_id, redirect_uri: input.req.redirectUri, redirect_explicit: input.req.redirectExplicit, code_challenge: input.req.codeChallenge, scopes, resource: input.req.resource, expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  await store.insertAudit({ tenant_id: input.tenantId, actor: `owner:${input.user.email}`, action: "oauth.consent", payload: { grantId: grant.id, client: input.req.client.client_name ?? input.req.client.client_id, scopes } });
  const u = new URL(input.req.redirectUri);
  u.searchParams.set("code", code);
  if (input.req.state) u.searchParams.set("state", input.req.state);
  u.searchParams.set("iss", cfg.issuer);
  return { redirect: u.toString(), grantId: grant.id };
}

/* ================================================================== token 端點 */

function pkceOk(verifier: string, challenge: string) {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(b64url(createHash("sha256").update(verifier).digest()));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function issuePair(store: Store, grant: OAuthGrantRow, scopes: string[], parentId: string | null) {
  const access = `gboa_${b64url(randomBytes(32))}`;
  const refresh = `gbor_${b64url(randomBytes(32))}`;
  const now = Date.now();
  await store.insertOAuthToken({ token_hash: sha256(access), kind: "access", grant_id: grant.id, client_id: grant.client_id, scopes, resource: grant.resource, parent_id: parentId, expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString() });
  const refreshExp = Math.min(now + REFRESH_TTL_S * 1000, Date.parse(grant.created_at) + GRANT_MAX_AGE_S * 1000);
  await store.insertOAuthToken({ token_hash: sha256(refresh), kind: "refresh", grant_id: grant.id, client_id: grant.client_id, scopes, resource: grant.resource, parent_id: parentId, expires_at: new Date(refreshExp).toISOString() });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
}

async function grantStillValid(store: Store, grant: OAuthGrantRow | null): Promise<boolean> {
  if (!grant || grant.revoked_at) return false;
  if (Date.parse(grant.created_at) + GRANT_MAX_AGE_S * 1000 <= Date.now()) return false;
  const [user, m] = await Promise.all([store.getOwnerUserById(grant.user_id), store.getTenantUser(grant.tenant_id, grant.user_id)]);
  return !!user && user.status === "active" && !!m && m.status === "active";
}

/** client 認證：public client，只用 client_id（form 或 Basic 的 username） */
function clientIdFrom(form: URLSearchParams, authorization: string | null): string {
  const basic = authorization && /^Basic\s+(.+)$/i.exec(authorization);
  if (basic) {
    const dec = Buffer.from(basic[1]!, "base64").toString("utf8");
    return decodeURIComponent(dec.split(":")[0] ?? "");
  }
  return form.get("client_id") ?? "";
}

export async function tokenEndpoint(store: Store, cfg: OAuthConfig, form: URLSearchParams, authorization: string | null) {
  const grantType = form.get("grant_type");
  const clientId = clientIdFrom(form, authorization);
  if (!clientId) throw new OAuthError("invalid_client", "缺少 client_id", 401);
  const resRaw = form.get("resource");
  if (resRaw && normalizeResource(resRaw) !== normalizeResource(cfg.resource)) throw new OAuthError("invalid_target", `resource 必須是 ${cfg.resource}`);
  const nowIso = new Date().toISOString();

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const hash = sha256(code);
    const c = await store.consumeOAuthCode(hash, nowIso);
    if (!c) {
      // 🔴 授權碼重用（已用過）→ 撤銷用它換到的所有 token
      const prev = await store.getOAuthCodeByHash(hash);
      if (prev?.used_at) await store.revokeOAuthGrant(prev.grant_id, "code_reuse");
      throw new OAuthError("invalid_grant", "授權碼無效、已使用或已過期");
    }
    if (c.client_id !== clientId) throw new OAuthError("invalid_grant", "授權碼不是發給這個 client 的");
    // 授權請求有帶 redirect_uri → token 請求必須帶一樣的；沒帶（伺服器用唯一註冊的那個）→ 可以不帶，帶了就要相同（L13）
    const givenRedirect = form.get("redirect_uri");
    if (c.redirect_explicit ? givenRedirect !== c.redirect_uri : givenRedirect !== null && givenRedirect !== c.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri 與授權請求不符");
    if (!pkceOk(form.get("code_verifier") ?? "", c.code_challenge)) throw new OAuthError("invalid_grant", "PKCE 驗證失敗（code_verifier 不符）");
    const grant = await store.getOAuthGrant(c.grant_id);
    if (!grant || !(await grantStillValid(store, grant))) throw new OAuthError("invalid_grant", "授權已撤銷");
    return issuePair(store, grant, c.scopes, null);
  }

  if (grantType === "refresh_token") {
    const raw = form.get("refresh_token") ?? "";
    const hash = sha256(raw);
    const t = await store.consumeRefreshToken(hash, nowIso);
    if (!t) {
      // 🔴 refresh token 重用（已輪替過的又出現）→ 可能外洩：撤銷整個授權
      const prev = await store.getOAuthTokenByHash(hash);
      if (prev?.kind === "refresh" && prev.used_at && !prev.revoked_at) await store.revokeOAuthGrant(prev.grant_id, "refresh_reuse");
      throw new OAuthError("invalid_grant", "refresh token 無效、已使用或已過期");
    }
    if (t.client_id !== clientId) {
      await store.revokeOAuthGrant(t.grant_id, "refresh_wrong_client");
      throw new OAuthError("invalid_grant", "refresh token 不是發給這個 client 的");
    }
    const grant = await store.getOAuthGrant(t.grant_id);
    if (!grant || !(await grantStillValid(store, grant))) throw new OAuthError("invalid_grant", "授權已撤銷");
    const narrowed = form.get("scope") ? parseScopes(form.get("scope")).filter((s) => t.scopes.includes(s)) : t.scopes;
    if (!narrowed.length) throw new OAuthError("invalid_scope", "scope 不能超出原本授權的範圍");
    return issuePair(store, grant, narrowed, t.id);
  }
  throw new OAuthError("unsupported_grant_type", "只支援 authorization_code、refresh_token");
}

/** RFC 7009：一律回 200；refresh token → 撤銷整個授權；access token → 撤銷這一個 */
export async function revokeEndpoint(store: Store, form: URLSearchParams, authorization: string | null) {
  const raw = form.get("token") ?? "";
  const clientId = clientIdFrom(form, authorization);
  const t = raw ? await store.getOAuthTokenByHash(sha256(raw)) : null;
  if (!t || (clientId && t.client_id !== clientId)) return;
  if (t.kind === "refresh") await store.revokeOAuthGrant(t.grant_id, "revoked_by_client");
  else await store.revokeOAuthToken(t.id);
}

/* ================================================================== 資源伺服器：驗 access token */

export function isOAuthAccessToken(raw: string) {
  return raw.startsWith("gboa_");
}

/**
 * 驗 OAuth access token → Actor。🔴 audience：token 的 resource 必須等於這個 MCP 端點的 canonical resource；
 * 授權未撤銷、店主帳號與成員資格仍啟用；scopes＝token scopes ∩ 目前角色的 scopes（降級立即生效）。
 */
export async function authenticateOAuthAccess(store: Store, raw: string, resource: string): Promise<Actor | null> {
  if (!/^gboa_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const t = await store.getOAuthTokenByHash(sha256(raw));
  if (!t || t.kind !== "access" || t.revoked_at || Date.parse(t.expires_at) <= Date.now()) return null;
  if (normalizeResource(t.resource) !== normalizeResource(resource)) return null;
  const grant = await store.getOAuthGrant(t.grant_id);
  if (!grant || grant.revoked_at) return null;
  const [user, m] = await Promise.all([store.getOwnerUserById(grant.user_id), store.getTenantUser(grant.tenant_id, grant.user_id)]);
  if (!user || user.status !== "active" || !m || m.status !== "active") return null;
  const role = new Set(scopesForRole(m.role));
  const scopes = t.scopes.filter((s): s is Scope => isScope(s) && role.has(s) && s !== "platform:sites");
  if (!grant.last_used_at || Date.parse(grant.last_used_at) < Date.now() - 5 * 60_000) await store.touchOAuthGrant(grant.id, new Date().toISOString()).catch(() => undefined);
  const client = await store.getOAuthClient(grant.client_id);
  return { kind: "token", label: `oauth:${client?.client_name ?? "client"}(${user.email})`, tenantId: grant.tenant_id, scopes, oauthGrantId: grant.id };
}
