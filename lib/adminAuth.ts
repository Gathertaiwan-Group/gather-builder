/**
 * 平台擁有者後台：單一密碼 → HMAC 簽章 cookie（edge 與 node 共用 WebCrypto）。
 * cookie 值 = `<exp 秒>.<hex hmac("admin:<exp>")>`。
 */
export const ADMIN_COOKIE = "gb_admin";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionValue(secret: string, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + ADMIN_SESSION_SECONDS;
  return `${exp}.${await hmacHex(secret, `admin:${exp}`)}`;
}

export async function verifySessionValue(value: string | undefined | null, secret: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (!value || !secret || secret.length < 16) return false;
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  return constantTimeEqual(sig, await hmacHex(secret, `admin:${exp}`));
}

/** 密碼比對：兩邊都先 HMAC 再常數時間比較（長度不洩漏） */
export async function passwordMatches(input: string, expected: string | undefined, secret: string | undefined): Promise<boolean> {
  if (!expected || !secret) return false;
  const [a, b] = await Promise.all([hmacHex(secret, `pw:${input}`), hmacHex(secret, `pw:${expected}`)]);
  return constantTimeEqual(a, b);
}
