/**
 * 「同一個信箱」的正規化（2026-10 審查 H-1／M-3）：用來比對自推、首單回饋、每人折扣碼次數、確認信冷卻。
 * - 一律小寫、去空白；
 * - 本機部分去掉 +tag（多數信箱服務 a+x@ 與 a@ 是同一個收件匣）；
 * - gmail.com／googlemail.com：去掉本機部分的「.」，googlemail.com 視為 gmail.com。
 * 🔴 只用來比對，不要拿來寄信或存成使用者的 email。仍無法辨識「不同信箱的同一個人」（已知限制）。
 */
export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

export const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && normalizeEmail(a) === normalizeEmail(b);
