import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getStore } from "../store";
import { baseUrlFrom } from "../runtime";
import { requireSecret } from "../secrets";
import { clientIp } from "../client-ip";
import { hashIp } from "../services/inquiries";
import { OWNER_COOKIE, getOwnerSession } from "../services/owners";
import { OAuthError, approveAuthorization, authorizationServerMetadata, errorRedirect, oauthConfig, protectedResourceMetadata, registerClient, revokeEndpoint, tokenEndpoint, validateAuthorize } from "../services/oauth";

/** OAuth 2.1 端點的 route 實作（app/oauth/*、app/.well-known/* 只是轉呼叫）。🔴 不把 token／code 寫進 log */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache", ...CORS, ...extra } });
export const corsPreflight = () => new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });

export const handlePrm = (req: Request) => json(protectedResourceMetadata(oauthConfig(baseUrlFrom(req))));
export const handleAsMetadata = (req: Request) => json(authorizationServerMetadata(oauthConfig(baseUrlFrom(req))));

async function limited(req: Request, bucket: string, windowS: number, max: number) {
  const hit = await getStore().rateHit(bucket, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), windowS, max);
  return !hit.allowed;
}

function oauthErr(e: unknown) {
  if (e instanceof OAuthError) return json(e.body(), e.status, e.status === 401 ? { "www-authenticate": 'Basic realm="oauth"' } : {});
  console.error("[oauth] 內部錯誤", e instanceof Error ? e.message : "unknown");
  return json({ error: "server_error", error_description: "伺服器錯誤" }, 500);
}

export async function handleRegister(req: Request) {
  try {
    if (await limited(req, "oauth-register", 3600, 20)) return json({ error: "too_many_requests", error_description: "註冊太頻繁" }, 429);
    if (Number(req.headers.get("content-length") ?? 0) > 20_000) throw new OAuthError("invalid_client_metadata", "內容太長");
    const body = await req.json().catch(() => null);
    const r = await registerClient(getStore(), body, { ipHash: hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")) });
    return json(r, 201);
  } catch (e) {
    return oauthErr(e);
  }
}

async function formOf(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 20_000) throw new OAuthError("invalid_request", "內容太長");
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return new URLSearchParams(Object.entries((await req.json()) as Record<string, string>).map(([k, v]) => [k, String(v)]));
  return new URLSearchParams(await req.text());
}

export async function handleToken(req: Request) {
  try {
    if (await limited(req, "oauth-token", 600, 120)) return json({ error: "too_many_requests", error_description: "太頻繁" }, 429);
    const r = await tokenEndpoint(getStore(), oauthConfig(baseUrlFrom(req)), await formOf(req), req.headers.get("authorization"));
    return json(r);
  } catch (e) {
    return oauthErr(e);
  }
}

export async function handleRevoke(req: Request) {
  try {
    await revokeEndpoint(getStore(), await formOf(req), req.headers.get("authorization"));
  } catch (e) {
    if (!(e instanceof OAuthError)) console.error("[oauth] revoke", e instanceof Error ? e.message : "unknown");
  }
  return new Response(null, { status: 200, headers: { ...CORS, "cache-control": "no-store" } });
}

/** 同意表單的 CSRF token：綁店主 session 與這次授權請求（client、redirect_uri、PKCE challenge） */
export function consentToken(sessionId: string, p: URLSearchParams) {
  return createHmac("sha256", requireSecret("PREVIEW_SECRET")).update(`oauth-consent:${sessionId}:${p.get("client_id")}:${p.get("redirect_uri")}:${p.get("code_challenge")}`).digest("base64url");
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** 店主按「同意」或「拒絕」：同源 Origin＋CSRF token＋重新驗證整個授權請求＋店主 session → 303 回 client */
export async function handleDecision(req: Request) {
  const base = baseUrlFrom(req);
  const cfg = oauthConfig(base);
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(base).origin) return new Response("forbidden origin", { status: 403 });
  const f = new URLSearchParams(await req.text());
  const store = getStore();
  const s = await getOwnerSession(store, readCookie(req, OWNER_COOKIE));
  if (!s) return NextResponse.redirect(new URL(`/owner/login?next=${encodeURIComponent(`/oauth/authorize?${authorizeQuery(f)}`)}`, base), 303);
  const csrf = f.get("csrf") ?? "";
  const want = consentToken(s.session.id, f);
  if (csrf.length !== want.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(want))) return new Response("invalid consent token", { status: 400 });
  if (await limited(req, `oauth-consent:${s.user.id}`, 600, 30)) return new Response("too many requests", { status: 429 });
  const v = await validateAuthorize(store, cfg, f);
  if (!v.ok) return v.redirect ? NextResponse.redirect(v.redirect, 303) : new Response(v.error.description, { status: 400 });
  if (f.get("decision") !== "approve") return NextResponse.redirect(errorRedirect(cfg, v.req.redirectUri, new OAuthError("access_denied", "使用者拒絕授權"), v.req.state), 303);
  try {
    const r = await approveAuthorization(store, cfg, { user: s.user, tenantId: f.get("tenant_id") ?? "", req: v.req, scopes: f.getAll("grant_scope") });
    return NextResponse.redirect(r.redirect, 303);
  } catch (e) {
    if (e instanceof OAuthError) return NextResponse.redirect(errorRedirect(cfg, v.req.redirectUri, e, v.req.state), 303);
    throw e;
  }
}

export const AUTHORIZE_PARAMS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;
export function authorizeQuery(p: URLSearchParams) {
  const q = new URLSearchParams();
  for (const k of AUTHORIZE_PARAMS) {
    const v = p.get(k);
    if (v !== null) q.set(k, v);
  }
  return q.toString();
}
