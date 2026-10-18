import { z } from "zod";
import { text } from "../validators";
import { emailSchema } from "./members";

/**
 * 課程類模組共用的「葉節點」定義（只依賴 zod／validators／members）：
 * 🔴 events／booking 在模組載入時就用 classContactInput 組 zod schema，若它放在 class-orders（會 import shop → orders → events）
 * 會形成循環、在某些進入點（例如證照後台路由）出現 TDZ「Cannot access before initialization」。所以拆成這支不會繞回來的檔案。
 */
export const classContactInput = z
  .object({
    name: text(80),
    email: emailSchema,
    phone: z.string().trim().min(6, { message: "請填寫電話" }).max(40),
  })
  .strict();
export type ClassContact = z.output<typeof classContactInput>;

export function maskName(n: string): string {
  const c = [...n.trim()];
  if (c.length <= 1) return "＊";
  if (c.length === 2) return `${c[0]}＊`;
  return `${c[0]}${"＊".repeat(Math.min(3, c.length - 2))}${c[c.length - 1]}`;
}
export function maskEmail(e: string): string {
  const [local, domain] = e.split("@");
  if (!domain) return "＊＊＊";
  return `${(local ?? "").slice(0, 2)}＊＊＊@${domain}`;
}
export function maskPhone(p: string): string {
  const d = p.replace(/\s/g, "");
  if (d.length <= 6) return "＊＊＊";
  return `${d.slice(0, 4)}＊＊＊${d.slice(-3)}`;
}
export const maskContact = (c: { name: string; email: string; phone: string }) => ({ name: maskName(c.name), email: maskEmail(c.email), phone: maskPhone(c.phone) });

