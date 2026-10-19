/**
 * e2e-platform 用：模擬「平台 PChomePay 權威回查＝已付款」來觸發開站（🔴 不打任何金流 API：回查用假的 fetch，金額取自訂單本身）。
 * 走的是正式的 handlePlatformNotify → settleFromQuery → provisionPlatformOrder 路徑（同一套程式），只把回查結果換成「已付」。
 * 只允許 sandbox＋is_test 的訂單。邀請信沒設 Resend 時會寫在這個程序的 stdout（e2e 從這裡拿設定密碼連結）。
 * 用法：npx tsx --env-file=.env.local scripts/e2e-platform-settle.mts <訂單編號> <平台網址>
 */
import { createSupabaseStore } from "../lib/store/supabase";
import { handlePlatformNotify } from "../lib/services/platform-billing";

const [orderNo, baseUrl] = process.argv.slice(2);
if (!orderNo || !baseUrl || !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl)) throw new Error("用法：<訂單編號> <http://localhost:port>（只限本機）");
const store = createSupabaseStore();
const o = await store.getPlatformOrderByNo(orderNo);
if (!o || !o.sandbox || !o.is_test || !o.gateway_order_no) throw new Error("只限 sandbox＋is_test、已建立付款的訂單");
process.env.PLATFORM_PCHOMEPAY_APP_ID ||= "E2E-FAKE";
process.env.PLATFORM_PCHOMEPAY_SECRET ||= "e2e-fake-secret";
process.env.PLATFORM_PCHOMEPAY_SANDBOX = "true";
const fetchImpl = async (url: string) => {
  const u = new URL(url);
  const j = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
  if (u.pathname === "/v1/token") return j({ token: "e2e", expired_timestamp: Math.floor(Date.now() / 1000) + 600 });
  if (u.pathname === `/v1/payment/${o.gateway_order_no}`) return j({ order_id: o.gateway_order_no, status: "S", status_code: null, amount: o.amount_total });
  throw new Error(`unexpected ${url}`);
};
const body = new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: o.gateway_order_no }) }).toString();
const r = await handlePlatformNotify({ store, baseUrl, previewSecret: process.env.PREVIEW_SECRET!, fetchImpl, gemini: null }, body);
console.log(`SETTLE_OUTCOME=${r.outcome} status=${r.status}`);
const again = await handlePlatformNotify({ store, baseUrl, previewSecret: process.env.PREVIEW_SECRET!, fetchImpl, gemini: null }, body);
console.log(`SETTLE_AGAIN=${again.outcome}`);
