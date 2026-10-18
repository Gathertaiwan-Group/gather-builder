import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 金流憑證加密：AES-256-GCM，金鑰來自 env PAYMENT_ENC_KEY（32 bytes，base64 或 hex）。
 * 格式 `v1.<kid>.<iv>.<tag>.<ciphertext>`（base64url）；kid = sha256(key) 前 8 hex，換金鑰時可辨識。
 * AAD 綁定 tenant_id：把 A 租戶的密文複製到 B 租戶的列，解密會失敗。
 */
export function loadEncKey(raw = process.env.PAYMENT_ENC_KEY): Buffer {
  if (!raw) throw new Error("PAYMENT_ENC_KEY 未設定");
  const v = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("PAYMENT_ENC_KEY 必須是 32 bytes（base64 或 64 位 hex）");
  return key;
}

const kidOf = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

export function encryptSecret(plain: string, aad: string, key: Buffer = loadEncKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", kidOf(key), iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(enc: string, aad: string, key: Buffer = loadEncKey()): string {
  const [v, kid, iv, tag, ct] = enc.split(".");
  if (v !== "v1" || !kid || !iv || !tag || !ct) throw new Error("密文格式不正確");
  if (kid !== kidOf(key)) throw new Error("密文不是用目前的 PAYMENT_ENC_KEY 加密的（金鑰不符）");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
