import { timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import { expireDueOrders } from "@/lib/services/orders";
import { retryDueInvoices } from "@/lib/services/invoices";
import { json } from "@/lib/http";

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
  console.log(`[cron/expire-orders] scanned=${r.scanned} expired=${r.expired} invoices=${inv.scanned}/${inv.issued}`);
  return json({ ...r, invoices: inv });
}
