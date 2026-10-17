import { createHmac, timingSafeEqual } from "node:crypto";

/** 預覽連結簽章：payload = { t: tenantId, e: 到期 epoch 秒 }，HMAC-SHA256。 */
export const PREVIEW_TTL_SECONDS = 60 * 60;

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createPreviewToken(tenantId: string, secret: string, nowMs = Date.now(), ttl = PREVIEW_TTL_SECONDS): string {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, e: Math.floor(nowMs / 1000) + ttl })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export type PreviewCheck = { ok: true } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_tenant" };

export function verifyPreviewToken(token: string, tenantId: string, secret: string, nowMs = Date.now()): PreviewCheck {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts as [string, string];
  const expected = Buffer.from(sign(payload, secret));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, reason: "bad_signature" };
  let data: { t?: unknown; e?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof data.e !== "number" || typeof data.t !== "string") return { ok: false, reason: "malformed" };
  if (data.e * 1000 < nowMs) return { ok: false, reason: "expired" };
  if (data.t !== tenantId) return { ok: false, reason: "wrong_tenant" };
  return { ok: true };
}
