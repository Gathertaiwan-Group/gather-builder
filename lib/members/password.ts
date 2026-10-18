import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * 會員密碼雜湊：Node 內建 scrypt＋每人隨機 salt。
 * 格式 `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`：參數寫進字串，日後調高成本時舊雜湊仍可驗證
 *（needsRehash 為 true 時可在登入成功後重算）。
 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

function scryptAsync(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(pw: string): Promise<string> {
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (!salt.length || !expected.length) return false;
  const key = await scryptAsync(pw, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function needsRehash(stored: string): boolean {
  const [, N, r, p] = stored.split("$");
  return Number(N) !== SCRYPT_PARAMS.N || Number(r) !== SCRYPT_PARAMS.r || Number(p) !== SCRYPT_PARAMS.p;
}

/** 帳號不存在時也跑一次同成本的雜湊，讓回應時間不洩漏帳號是否存在 */
let dummy: Promise<string> | null = null;
export async function burnPasswordCheck(pw: string): Promise<void> {
  dummy ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(pw, await dummy);
}
