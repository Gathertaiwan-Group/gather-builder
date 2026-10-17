/** 讀必要的 secret；沒設就丟錯（功能整個關閉，而不是用空字串簽章）。 */
export function requireSecret(name: "ADMIN_SESSION_SECRET" | "PREVIEW_SECRET" | "ADMIN_PASSWORD"): string {
  const v = process.env[name];
  if (!v || v.length < 8) throw new Error(`環境變數 ${name} 未設定或太短`);
  return v;
}
