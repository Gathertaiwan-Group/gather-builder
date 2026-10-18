import { timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import { expireDueOrders } from "@/lib/services/orders";
import { retryDueInvoices } from "@/lib/services/invoices";
import { json } from "@/lib/http";
import { runEventsCron } from "@/lib/services/events";
import { getMailer } from "@/lib/mail";
import { baseUrlFrom } from "@/lib/runtime";

// 每日 cron（Vercel Hobby 只能每日）：逾期未付訂單 → 取消並回補庫存（冪等）；發票重試。平常由讀取時 lazy 處理。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const r = await expireDueOrders(getStore(), 500);
  // 發票：重試待開立／可重試失敗（永久錯誤已設到上限，只能人工重試）
  const inv = await retryDueInvoices(getStore(), 50);
  // 第四批：活動候補遞補（過期保留換下一位）、活動前提醒（今天稍晚與明天的場次，每筆只寄一次）
  const deps = { store: getStore(), sendMail: getMailer(), baseUrl: baseUrlFrom(req) };
  const ev = await runEventsCron(deps).catch((e) => (console.error("[cron] events", e), { offered: -1, reminded: -1 }));
  console.log(`[cron/expire-orders] scanned=${r.scanned} expired=${r.expired} invoices=${inv.scanned}/${inv.issued} events=${JSON.stringify(ev)}`);
  return json({ ...r, invoices: inv, events: ev });
}
