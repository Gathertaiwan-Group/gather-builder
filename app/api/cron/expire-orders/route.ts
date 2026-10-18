import { timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import { expireDueOrders, retryOrderHooks, sweepStaleRefunds } from "@/lib/services/orders";
import { retryDueInvoices } from "@/lib/services/invoices";
import { json } from "@/lib/http";
import { runEventsCron } from "@/lib/services/events";
import { runBookingCron } from "@/lib/services/booking";
import { runLoyaltyCron } from "@/lib/services/loyalty";
import { runWalletCron } from "@/lib/services/wallet";
import { sweepSubscriptions } from "@/lib/services/subscriptions";
import { sweepGroupBuys } from "@/lib/services/groupbuy";
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
  const bk = await runBookingCron(deps).catch((e) => (console.error("[cron] booking", e), { reminded: -1 }));
  // M2：補做失敗的付款／取消副作用（冪等；連續失敗警示店主）
  const hooks = await retryOrderHooks(deps, { limit: 200 }).catch((e) => (console.error("[cron] hooks", e), { scanned: -1, resolved: 0, failed: 0 }));
  // 第五批：點數到期（FIFO）、等級降級
  const loyalty = await runLoyaltyCron(getStore()).catch((e) => (console.error("[cron] loyalty", e), { expired: -1, evaluated: 0, changed: 0 }));
  const wallet = await runWalletCron(getStore()).catch((e) => (console.error("[cron] wallet", e), { expired: -1 }));
  // 第七批：訂閱寬限到期停權、應扣未扣進寬限、終止委託重試、放棄的 pending
  const subs = await sweepSubscriptions(deps).catch((e) => (console.error("[cron] subscriptions", e), { expired: -1 }));
  // 第七批審查 L2：卡住的退款（requested 超過 15 分鐘）→ 結果不明＋警示店主
  const refunds = await sweepStaleRefunds(deps).catch((e) => (console.error("[cron] refunds", e), { scanned: -1, marked: 0 }));
  // 第八批：截止的團購自動結團（未達門檻取消訂單並通知；冪等、可接續）
  const groupBuys = await sweepGroupBuys(deps).catch((e) => (console.error("[cron] group-buy", e), { scanned: -1, settled: 0 }));
  console.log(`[cron/expire-orders] groupBuys=${JSON.stringify(groupBuys)}`);
  console.log(`[cron/expire-orders] subscriptions=${JSON.stringify(subs)} refunds=${JSON.stringify(refunds)}`);
  console.log(`[cron/expire-orders] loyalty=${JSON.stringify(loyalty)} wallet=${JSON.stringify(wallet)}`);
  console.log(`[cron/expire-orders] scanned=${r.scanned} expired=${r.expired} invoices=${inv.scanned}/${inv.issued} events=${JSON.stringify(ev)} booking=${JSON.stringify(bk)} hooks=${JSON.stringify(hooks)}`);
  return json({ ...r, invoices: inv, events: ev, booking: bk, hooks, loyalty, wallet, subscriptions: subs, refunds, groupBuys });
}
