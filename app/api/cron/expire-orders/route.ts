import { timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import { expireDueOrders } from "@/lib/services/orders";
import { json } from "@/lib/http";

// 每日 cron（Vercel Hobby 只能每日）：逾期未付訂單 → 取消並回補庫存（冪等）。平常由讀取時 lazy 處理。
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
  console.log(`[cron/expire-orders] scanned=${r.scanned} expired=${r.expired}`);
  return json(r);
}
