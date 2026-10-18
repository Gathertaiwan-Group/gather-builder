import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 每筆付款的 callback／導回網址簽章（第七批）：HMAC(PREVIEW_SECRET, `pay:<用途>:<付款 id 或閘道編號>`)。
 * 只當「額外一道門」：真正的判定一律是 provider 簽章驗證＋權威回查。黑貓 PAY 的 APN checksum 不含祕密，這道門讓別人連
 * 「組一則格式正確的通知」都做不到（不知道 token）。換 PREVIEW_SECRET 會讓還沒完成的付款 callback 被拒（之後逾期前回查仍會認回）。
 */
function secret(): string {
  const v = process.env.PREVIEW_SECRET;
  if (!v || v.length < 8) throw new Error("環境變數 PREVIEW_SECRET 未設定或太短");
  return v;
}

export function payToken(purpose: "notify" | "return" | "confirm", key: string): string {
  return createHmac("sha256", secret()).update(`pay:${purpose}:${key}`).digest("base64url").slice(0, 32);
}

export function verifyPayToken(purpose: "notify" | "return" | "confirm", key: string, token: unknown): boolean {
  if (typeof token !== "string" || token.length !== 32) return false;
  const a = Buffer.from(payToken(purpose, key));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
