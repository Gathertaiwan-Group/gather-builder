import { intAmount, md5Hex, safeEqual, taipeiFormat } from "./crypto";
import { defaultFetch, fetchWithTimeout, type AuthoritativeResult, type CallbackCheck, type FetchLike, type PaymentProvider, type RefundResult } from "./types";

/**
 * 黑貓 PAY（統一客樂得 COCS 多元支付平台），每個租戶自己的 CUST_ID。
 * 規格：「多元支付平台-WEBAPI介面規格 V1.28.2」（簽約後取得，無公開網址；以下 P# 為該規格頁碼）。
 * 依據：快樂手正式站 happyhand/apps/web/lib/payment/blackcat.ts、小時光 alice-store/src/server/blackcat.ts（同一家閘道的真單驗證）。
 *
 * 🔴 安全重點：
 * 1. APN 的 checksum = MD5(api_id:trans_id:amount:status:nonce)（P90）**不含任何祕密，可被偽造**。
 *    → 只當雜訊過濾；另在 apn_url 帶每筆付款的 HMAC token（services/payments.ts）；**一律 CocsOrderQuery 回查 process_code**，
 *      只有 15／20／21／22（授權完成／請求請款／請款中／請款完成）算已付。
 * 2. 🔴 金額只能用 APN 的 `payment_detail.pay_amount`（P35 注意事項 2）。回查回應**沒有實收金額**：
 *    `order_amount`／`request_amount` 只是我們送出的數字念回來，`grant_amount` 是扣手續費後的撥付淨額（1800→1760）**絕不可拿來比對**。
 *    → 已付判定：回查 process_code ∈ 已付 ＋ 回查 order_amount＝付款紀錄 ＋ APN pay_amount＝付款紀錄。沒有 APN（逾期前回查）時缺實收金額 → 不標記、警示店主。
 * 3. APN 回應必須是純文字 `OK`（否則每 15 分鐘重送、同狀態最多 3 次）；我們要求重送時回 500。
 * 4. 測試機 base URL 含 `/app`（https://test.4128888card.com.tw/app），與正式機資料不互通；需另外申請測試帳號（無公開測試特店）。
 */
export function blackcatBase(test: boolean) {
  return test ? "https://test.4128888card.com.tw/app" : "https://cocs.4128888card.com.tw";
}

/** APN checksum（P90）：官方範例 api_id CC0000000001、trans_id 550e8400e29b41d4a716446655440000、amount 1250、status B、nonce 1234569999 → d09d5532767453ad4c6ba9b649034187 */
export function blackcatApnChecksum(p: { api_id: string; trans_id: string; amount: string; status: string; nonce: string }): string {
  return md5Hex(`${p.api_id}:${p.trans_id}:${p.amount}:${p.status}:${p.nonce}`);
}

export const BLACKCAT_PAID_CODES = new Set([15, 20, 21, 22]);
const PENDING_CODES = new Set([13, 14]);
const FAILED_CODES = new Set([5, 6, 16, 17, 27]);

/** CocsOrderQuery 的 process_code 判讀（規格附錄一 P94–95）；23 請款失敗與其他未知碼一律 unknown（人工確認） */
export function classifyBlackcatProcessCode(code: number | undefined): AuthoritativeResult["state"] {
  if (code === undefined) return "unknown";
  if (BLACKCAT_PAID_CODES.has(code)) return "paid";
  if (PENDING_CODES.has(code)) return "pending";
  if (FAILED_CODES.has(code)) return "failed";
  return "unknown";
}

export interface BlackcatCreds {
  /** CUST_ID（＝APN 的 api_id） */
  custId: string;
  apiPassword: string;
  /** 「取消交易&退刷密碼」（選填；沒有就不提供自動退款） */
  refundPassword?: string;
  /** 收單行：esun／chinatrust／payuni（依合約，預設 payuni） */
  acquirerType?: "esun" | "chinatrust" | "payuni";
  test: boolean;
  cacheKey: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number; fp: string }>();
export function clearBlackcatTokenCache() {
  tokenCache.clear();
}

/** APN 的 JSON 本體（數字欄位可能是 number 或 string） */
export function parseBlackcatApn(rawBody: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(rawBody);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    const sp = new URLSearchParams(rawBody);
    if (!sp.get("checksum")) return null;
    const o: Record<string, unknown> = {};
    for (const [k, v] of sp) o[k] = v;
    return o;
  }
}

export function createBlackcatProvider(creds: BlackcatCreds, fetchImpl: FetchLike = defaultFetch, now: () => Date = () => new Date()) {
  const base = blackcatBase(creds.test);
  const fp = `${creds.test ? "t" : "p"}:${creds.custId}`;

  async function token(force = false): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
    const c = tokenCache.get(creds.cacheKey);
    if (!force && c && c.fp === fp && c.expiresAt > Date.now()) return { ok: true, token: c.token };
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${base}/Token`,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", username: creds.custId, password: creds.apiPassword }).toString() },
        20_000,
      );
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const t = data?.access_token;
      if (!res.ok || typeof t !== "string") return { ok: false, message: `取得 token 失敗（HTTP ${res.status} ${String(data?.error_description ?? data?.error ?? data?.Error ?? "")}）` };
      // 規格說以 `.expires`（帶前導點）為準；提前 5 分鐘換，缺值用 30 分鐘
      const exp = Date.parse(String(data?.[".expires"] ?? "").trim());
      tokenCache.set(creds.cacheKey, { token: t, fp, expiresAt: Number.isFinite(exp) ? exp - 5 * 60_000 : Date.now() + 30 * 60_000 });
      return { ok: true, token: t };
    } catch (e) {
      return { ok: false, message: `連線失敗：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async function collect(body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string; unknown?: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await token(attempt > 0);
      if (!t.ok) return { ok: false, message: t.message };
      try {
        const res = await fetchWithTimeout(fetchImpl, `${base}/api/Collect`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.token}` }, body: JSON.stringify({ ...body, cust_id: creds.custId }) }, 30_000);
        if (res.status === 401 && attempt === 0) {
          tokenCache.delete(creds.cacheKey);
          continue;
        }
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!data) return { ok: false, message: `HTTP ${res.status} 回應不是 JSON`, unknown: true };
        // 回查回應是扁平的；舊版可能包在 data 殼裡（兩種都吃）
        const flat = data.data && typeof data.data === "object" ? { ...data, ...(data.data as Record<string, unknown>) } : data;
        return { ok: true, data: flat };
      } catch (e) {
        return { ok: false, message: `連線失敗或逾時：${e instanceof Error ? e.message : String(e)}`, unknown: true };
      }
    }
    return { ok: false, message: "token 失效" };
  }

  const sendTime = () => taipeiFormat(now(), "yyyy-MM-dd HH:mm:ss");

  async function query(gatewayOrderNo: string) {
    const r = await collect({ cmd: "CocsOrderQuery", cust_order_no: gatewayOrderNo });
    if (!r.ok) {
      console.error(`[blackcat] 查單失敗 ${gatewayOrderNo} ${r.message}`);
      return null;
    }
    if (String(r.data.status ?? "").toUpperCase() !== "OK") {
      console.error(`[blackcat] 查單回 ${String(r.data.status)} ${String(r.data.msg ?? "")}`);
      return null;
    }
    if (r.data.cust_order_no != null && String(r.data.cust_order_no) !== gatewayOrderNo) {
      console.error(`[blackcat] 查單回應的訂單號不符 ${gatewayOrderNo}`);
      return null;
    }
    return r.data;
  }

  const provider: PaymentProvider = {
    id: "blackcat",
    sandbox: creds.test,

    async verifyCredentials() {
      // 無副作用：只換 token（證明 CUST_ID＋API 密碼正確），不建單
      const t = await token(true);
      return t.ok ? { ok: true, note: creds.refundPassword ? undefined : "未設定退刷密碼：退款需到黑貓 PAY 後台操作" } : { ok: false, message: t.message };
    },

    async createPayment(input) {
      if (!/^[A-Za-z0-9-]{3,25}$/.test(input.gatewayOrderNo)) return null;
      if (!/^https:\/\//.test(input.notifyUrl) || input.notifyUrl.length > 250) {
        // alice-store 事故：apn_url 是 localhost → 付了錢訂單卻逾期。非 https 或過長的 apn_url 一律不建單
        console.error("[blackcat] apn_url 必須是 https 且 ≤ 250 字");
        return null;
      }
      const r = await collect({
        cmd: "CocsOrderAppend",
        cust_order_no: input.gatewayOrderNo,
        order_amount: Math.round(input.amount),
        order_detail: input.itemName.replace(/[<>]/g, " ").slice(0, 500),
        acquirer_type: creds.acquirerType ?? "payuni",
        send_time: sendTime(),
        apn_url: input.notifyUrl,
        success_url: input.returnUrl,
      });
      if (!r.ok || String(r.data.status ?? "").toUpperCase() !== "OK" || typeof r.data.url !== "string") {
        console.error(`[blackcat] 建單失敗 ${r.ok ? `${String(r.data.status)} ${String(r.data.msg ?? "")}` : r.message}`);
        return null;
      }
      return { kind: "redirect", url: r.data.url };
    },

    verifyCallback(rawBody): CallbackCheck {
      const p = parseBlackcatApn(rawBody);
      if (!p) return { ok: false, reason: "invalid_body" };
      const f = (k: string) => (p[k] == null ? "" : String(p[k]));
      const sum = f("checksum").trim().toLowerCase();
      if (!/^[0-9a-f]{32}$/.test(sum) || !safeEqual(sum, blackcatApnChecksum({ api_id: f("api_id"), trans_id: f("trans_id"), amount: f("amount"), status: f("status"), nonce: f("nonce") }))) {
        return { ok: false, reason: "checksum" };
      }
      if (f("api_id") !== creds.custId) return { ok: false, reason: "api_id" };
      if (!f("order_no")) return { ok: false, reason: "order_no" };
      const detail = (p.payment_detail && typeof p.payment_detail === "object" ? p.payment_detail : {}) as Record<string, unknown>;
      // 實收金額：payment_detail.pay_amount（代收代付的 APN 在頂層）
      const payAmount = intAmount(detail.pay_amount ?? p.pay_amount);
      return { ok: true, gatewayOrderNo: f("order_no"), merchantId: f("api_id"), hint: { status: f("status"), transId: f("trans_id"), payAmount } };
    },

    async queryPayment({ gatewayOrderNo, amount }, callback?: Record<string, unknown>) {
      const q = await query(gatewayOrderNo);
      if (!q) return null;
      const code = intAmount(q.process_code);
      const state = classifyBlackcatProcessCode(code);
      const out: AuthoritativeResult = { state, statusText: `process_code=${code ?? String(q.process_code ?? "-")}`, raw: q, tradeNo: q.trans_id != null ? String(q.trans_id) : undefined };
      if (state === "paid") {
        // 🔴 不用 grant_amount（淨額）。order_amount 只是念回我們送的數字：必須等於付款紀錄，否則視為無法辨識
        const echoed = intAmount(q.order_amount);
        if (echoed !== undefined && echoed !== Math.round(amount)) return { ...out, state: "unknown", statusText: `${out.statusText}（order_amount ${echoed} ≠ ${amount}）` };
        out.amount = intAmount(callback?.payAmount);
      }
      return out;
    },
  };

  if (creds.refundPassword) {
    provider.refund = async ({ gatewayOrderNo, amount }): Promise<RefundResult> => {
      // 🔴 取消授權 ≠ 退款：先查 process_code 再決定（快樂手實作）；先退錢成功才改狀態（呼叫端負責）
      const q = await query(gatewayOrderNo);
      if (!q) return { kind: "unknown", message: "退款前回查失敗，請稍後再試" };
      const code = intAmount(q.process_code);
      let cmd: "CocsOrderCancel" | "CocsOrderRefund";
      if (code === 15) cmd = "CocsOrderCancel";
      else if (code === 22) cmd = "CocsOrderRefund";
      else if (code === 20 || code === 21) return { kind: "rejected", message: "黑貓 PAY 請款作業中（每日 20:00 截止、隔日中午完成），目前無法取消或退款，請明天再試" };
      else return { kind: "rejected", message: `黑貓 PAY 訂單狀態 process_code=${code ?? "?"}，無法退款` };
      const r = await collect({ cmd, cust_order_no: gatewayOrderNo, cust_password: creds.refundPassword, ...(cmd === "CocsOrderRefund" ? { refund_amount: Math.round(amount) } : {}), send_time: sendTime() });
      if (!r.ok) return r.unknown ? { kind: "unknown", message: r.message } : { kind: "rejected", message: r.message };
      if (String(r.data.status ?? "").toUpperCase() === "OK") return { kind: "ok", raw: r.data };
      return { kind: "rejected", message: `黑貓 PAY ${cmd} 失敗：${String(r.data.msg ?? r.data.status ?? "")}`, raw: r.data };
    };
  }
  return provider;
}
