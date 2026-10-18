import { createHash, randomBytes } from "node:crypto";
import type { Store } from "./store/types";
import { isScope, type Scope } from "./scopes";

export interface Actor {
  kind: "admin" | "token";
  /** 寫進稽核紀錄的身分字串 */
  label: string;
  /** null = 平台級（可跨租戶） */
  tenantId: string | null;
  scopes: Scope[];
  tokenId?: string;
}

export const ADMIN_ACTOR_SCOPES: Scope[] = [
  "platform:sites",
  "site:read",
  "content:write",
  "design:write",
  "modules:write",
  "publish",
  "inquiries:read",
  "members:read",
  "members:write",
  "commerce:write",
  "orders:read",
  "orders:write",
  "invoices:write",
  "shipping:write",
  "marketing:write",
  "newsletter:read",
  "newsletter:write",
  "classes:write",
  "attendees:read",
  "attendees:write",
  "certificates:read",
  "certificates:write",
  "reviews:write",
  "points:adjust",
  "wallet:adjust",
];

export function adminActor(): Actor {
  return { kind: "admin", label: "admin", tenantId: null, scopes: ADMIN_ACTOR_SCOPES };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** 產生新 token。原文只在建立時回傳一次，資料庫只存 sha256。 */
export function generateToken(kind: "platform" | "tenant"): { raw: string; hash: string; prefix: string } {
  const raw = `${kind === "platform" ? "gbp" : "gbt"}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 10) };
}

/**
 * 認證集中在這裡：Authorization: Bearer <token> → Actor 或 null。
 * 雜湊比對本身就是常數時間的查表（攻擊者無法從 sha256 前綴推原文），撤銷的 token 一律拒絕。
 * 日後換 OAuth 2.1：只要把這支換成驗 access token，回同一個 Actor 形狀。
 */
export async function authenticateBearer(store: Store, authorization: string | null): Promise<Actor | null> {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) return null;
  const raw = m[1]!;
  if (raw.length < 20 || raw.length > 200) return null;
  const row = await store.findTokenByHash(hashToken(raw));
  if (!row || row.revoked_at) return null;
  const scopes = row.scopes.filter(isScope);
  // 平台級 scope 只對平台 token 有效
  const effective = row.tenant_id ? scopes.filter((s) => s !== "platform:sites") : scopes;
  await store.touchToken(row.id).catch(() => undefined);
  return {
    kind: "token",
    label: `token:${row.token_prefix}…(${row.name})`,
    tenantId: row.tenant_id,
    scopes: effective,
    tokenId: row.id,
  };
}
