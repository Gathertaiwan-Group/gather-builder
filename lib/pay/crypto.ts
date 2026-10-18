import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 常數時間字串比較（長度不同直接 false；長度本身不是祕密） */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const md5Hex = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
export const hmacSha256B64 = (key: string, s: string) => createHmac("sha256", key).update(s, "utf8").digest("base64");

/** AES-256-CBC（PKCS7）→ 小寫 hex。藍新 MPG／定期定額共用（key 32 bytes、iv 16 bytes，皆為字串原文） */
export function aesCbcEncryptHex(plain: string, key: string, iv: string): string {
  const c = createCipheriv("aes-256-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("hex");
}

/** AES-256-CBC 解密；嚴格 PKCS7（官方 strippadding：最後 N bytes 都等於 N），不符丟錯 */
export function aesCbcDecryptHex(hex: string, key: string, iv: string): string {
  const h = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 32 !== 0) throw new Error("密文格式不正確");
  const d = createDecipheriv("aes-256-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  d.setAutoPadding(false);
  const buf = Buffer.concat([d.update(Buffer.from(h, "hex")), d.final()]);
  const n = buf[buf.length - 1];
  if (!n || n > 32 || n > buf.length) throw new Error("padding 不正確");
  for (let i = buf.length - n; i < buf.length; i++) if (buf[i] !== n) throw new Error("padding 不正確");
  return buf.subarray(0, buf.length - n).toString("utf8");
}

/** AES-256-GCM（PAYUNi）：hex( base64(ct) + ":::" + base64(tag) )；key 32 bytes、iv 16 bytes 字串原文 */
export function aesGcmEncryptHex(plain: string, key: string, iv: string): string {
  const c = createCipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  const tag = c.getAuthTag().toString("base64");
  return Buffer.from(`${ct}:::${tag}`, "utf8").toString("hex");
}

export function aesGcmDecryptHex(hex: string, key: string, iv: string): string {
  const h = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2 !== 0) throw new Error("密文格式不正確");
  const parts = Buffer.from(h, "hex").toString("utf8").split(":::");
  if (parts.length !== 2) throw new Error("密文格式不正確");
  const tag = Buffer.from(parts[1]!, "base64");
  if (tag.length !== 16) throw new Error("密文格式不正確（tag）");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"), { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(Buffer.from(parts[0]!, "base64")), d.final()]).toString("utf8");
}

/** PHP http_build_query 相容（空白→+、其他 RFC3986 保留字元百分比編碼）；undefined／null 略過 */
export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) sp.append(k, String(v));
  return sp.toString();
}

/** 解析 application/x-www-form-urlencoded 或 JSON 物件（頂層字串值） */
export function parseBody(rawBody: string, contentType: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (/json/i.test(contentType) || rawBody.trim().startsWith("{")) {
    try {
      const o = JSON.parse(rawBody) as Record<string, unknown>;
      for (const [k, v] of Object.entries(o ?? {})) if (v != null && typeof v !== "object") out[k] = String(v);
      return out;
    } catch {
      return out;
    }
  }
  for (const [k, v] of new URLSearchParams(rawBody)) out[k] = v;
  return out;
}

/** 台北時間格式化（固定 UTC+8，與伺服器時區無關）；pattern 支援 yyyy MM dd HH mm ss */
export function taipeiFormat(d: Date, pattern: string): string {
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return pattern
    .replace("yyyy", String(t.getUTCFullYear()))
    .replace("MM", p(t.getUTCMonth() + 1))
    .replace("dd", p(t.getUTCDate()))
    .replace("HH", p(t.getUTCHours()))
    .replace("mm", p(t.getUTCMinutes()))
    .replace("ss", p(t.getUTCSeconds()));
}

/** 整數金額（字串或數字）；非整數回 undefined */
export function intAmount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v) === v ? v : undefined;
  if (typeof v === "string" && /^\s*\d+(\.0+)?\s*$/.test(v)) return Math.round(Number(v));
  return undefined;
}
