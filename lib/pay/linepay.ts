import { randomUUID } from "node:crypto";
import { hmacSha256B64, intAmount } from "./crypto";
import { defaultFetch, fetchWithTimeout, type AuthoritativeResult, type FetchLike, type PaymentProvider, type RefundResult } from "./types";

/**
 * LINE Pay Online API v3（每個租戶自己的 channel）。官方文件：https://developers-pay.line.me/online-api-v3
 *
 * 流程與安全規則：
 * - Request API 建單 → 導到 info.paymentUrl.web；客人授權後 LINE Pay 把瀏覽器導回 confirmUrl（`?transactionId=&orderId=`，**沒有簽章**）。
 * - 🔴 導回本身不代表付款：只有 server 端以 **DB 金額** 呼叫 Confirm API 成功（returnCode 0000）才算已付；同一 transactionId 只 confirm 一次
 *   （付款紀錄的 confirm 宣告是條件式更新，見 services/payments.ts）。
 * - Confirm 逾時／看不懂 → 不是失敗：用 Check API（/v3/payments/requests/{transactionId}/check）回查——
 *   0110＝已授權未 confirm（可補 confirm）、0123＝已完成、0121／0122＝取消／失敗、0000＝客人尚未授權。
 * - transactionId 是 19 位數，超過 JS 安全整數：JSON 解析前把 16 位以上的數字轉成字串（Realreal 曾因此查不到交易）。
 * - 簽章：Base64(HMAC-SHA256(channelSecret, channelSecret + uri + (POST: body | GET: query string) + nonce))。
 * - 沒有 server 對 server 的付款通知（不實作 verifyCallback）。
 */

export function linepayBase(sandbox: boolean) {
  return sandbox ? "https://sandbox-api-pay.line.me" : "https://api-pay.line.me";
}

export function linepaySignature(channelSecret: string, uri: string, bodyOrQuery: string, nonce: string): string {
  return hmacSha256B64(channelSecret, channelSecret + uri + bodyOrQuery + nonce);
}

/** 19 位數 transactionId 不能用 Number 表示：16 位以上的整數先轉字串再 JSON.parse */
export function parseLinepayJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text.replace(/:\s*(\d{16,})\b/g, ': "$1"')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const LINEPAY_TXN_RE = /^\d{1,20}$/;

export interface LinepayCreds {
  channelId: string;
  channelSecret: string;
  sandbox: boolean;
}

export type LinepayConfirmResult =
  | { kind: "ok"; amount?: number; raw: Record<string, unknown> }
  | { kind: "rejected"; code: string; message: string; raw: Record<string, unknown> }
  | { kind: "unknown"; message: string };

/** Check API returnCode → 狀態（Tinna 正式站實作與官方文件一致） */
export function classifyLinepayCheck(code: string): { state: AuthoritativeResult["state"]; needsConfirm?: boolean } {
  switch (code) {
    case "0123":
      return { state: "paid" };
    case "0110":
      return { state: "pending", needsConfirm: true };
    case "0000":
      return { state: "pending" };
    case "0121":
    case "0122":
      return { state: "failed" };
    default:
      return { state: "unknown" };
  }
}

export function createLinepayProvider(creds: LinepayCreds, fetchImpl: FetchLike = defaultFetch) {
  const base = linepayBase(creds.sandbox);

  async function call(method: "GET" | "POST", uri: string, opts: { body?: unknown; query?: string; timeoutMs: number }): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
    const nonce = randomUUID();
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    const q = opts.query ?? "";
    const signature = linepaySignature(creds.channelSecret, uri, method === "POST" ? body : q, nonce);
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${base}${uri}${q ? `?${q}` : ""}`,
        {
          method,
          headers: { "Content-Type": "application/json", "X-LINE-ChannelId": creds.channelId, "X-LINE-Authorization-Nonce": nonce, "X-LINE-Authorization": signature },
          body: method === "POST" ? body : undefined,
        },
        opts.timeoutMs,
      );
      const text = await res.text();
      const data = parseLinepayJson(text);
      if (!data) return { ok: false, message: `HTTP ${res.status} 回應不是 JSON` };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, message: `連線失敗或逾時：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const code = (d: Record<string, unknown>) => String(d.returnCode ?? "");
  const info = (d: Record<string, unknown>) => (d.info ?? {}) as Record<string, unknown>;

  /** Payment Details API：取已完成交易的實付金額（payInfo 加總） */
  async function paidAmount(transactionId: string): Promise<number | undefined> {
    const r = await call("GET", "/v3/payments", { query: `transactionId=${transactionId}`, timeoutMs: 20_000 });
    if (!r.ok || code(r.data) !== "0000") return undefined;
    const list = Array.isArray(r.data.info) ? (r.data.info as Record<string, unknown>[]) : [];
    const tx = list.find((t) => String(t.transactionId ?? "") === transactionId && String(t.transactionType ?? "PAYMENT") === "PAYMENT");
    if (!tx) return undefined;
    const payInfo = Array.isArray(tx.payInfo) ? (tx.payInfo as Record<string, unknown>[]) : [];
    if (!payInfo.length) return undefined;
    let sum = 0;
    for (const p of payInfo) {
      const a = intAmount(p.amount);
      if (a === undefined) return undefined;
      sum += a;
    }
    return sum;
  }

  const provider: PaymentProvider & {
    confirm(transactionId: string, amount: number): Promise<LinepayConfirmResult>;
  } = {
    id: "linepay",
    sandbox: creds.sandbox,

    async verifyCredentials() {
      // 無副作用：查詢一筆一定不存在的 orderId。簽章與 channel 正確時官方回 1150（查無交易）或 0000（空清單）
      const r = await call("GET", "/v3/payments", { query: `orderId=GBVERIFY${Date.now()}`, timeoutMs: 20_000 });
      if (!r.ok) return { ok: false, message: r.message };
      const c = code(r.data);
      if (c === "1150" || c === "0000") return { ok: true };
      return { ok: false, message: `LINE Pay 回應 ${c}：${String(r.data.returnMessage ?? "")}（請確認 Channel ID／Secret 與環境）` };
    },

    async createPayment(input) {
      const amount = Math.round(input.amount);
      const r = await call("POST", "/v3/payments/request", {
        timeoutMs: 20_000,
        body: {
          amount,
          currency: "TWD",
          orderId: input.gatewayOrderNo,
          packages: [{ id: input.gatewayOrderNo, amount, name: input.itemName.slice(0, 100), products: [{ name: input.itemName.slice(0, 100), quantity: 1, price: amount }] }],
          redirectUrls: { confirmUrl: input.returnUrl, cancelUrl: input.cancelUrl },
        },
      });
      if (!r.ok) {
        console.error(`[linepay] 建單失敗 ${r.message}`);
        return null;
      }
      if (code(r.data) !== "0000") {
        console.error(`[linepay] 建單失敗 returnCode=${code(r.data)} ${String(r.data.returnMessage ?? "")}`);
        return null;
      }
      const inf = info(r.data);
      const url = ((inf.paymentUrl ?? {}) as Record<string, unknown>).web;
      const tid = String(inf.transactionId ?? "");
      if (typeof url !== "string" || !LINEPAY_TXN_RE.test(tid)) return null;
      return { kind: "redirect", url, tradeNo: tid };
    },

    /** Confirm：金額一定要由呼叫端從 DB 帶入（不信導回網址的任何參數） */
    async confirm(transactionId: string, amount: number): Promise<LinepayConfirmResult> {
      if (!LINEPAY_TXN_RE.test(transactionId)) return { kind: "rejected", code: "local", message: "transactionId 格式不正確", raw: {} };
      // 官方建議 Confirm 逾時至少 40 秒
      const r = await call("POST", `/v3/payments/${transactionId}/confirm`, { timeoutMs: 45_000, body: { amount: Math.round(amount), currency: "TWD" } });
      if (!r.ok) return { kind: "unknown", message: r.message };
      const c = code(r.data);
      if (c === "0000") {
        const pi = Array.isArray(info(r.data).payInfo) ? (info(r.data).payInfo as Record<string, unknown>[]) : [];
        const sum = pi.length ? pi.reduce((s, p) => s + (intAmount(p.amount) ?? Number.NaN), 0) : undefined;
        const amount = sum !== undefined && Number.isFinite(sum) ? sum : await paidAmount(transactionId);
        return { kind: "ok", amount, raw: r.data };
      }
      return { kind: "rejected", code: c, message: String(r.data.returnMessage ?? ""), raw: r.data };
    },

    async queryPayment({ tradeNo }) {
      if (!tradeNo || !LINEPAY_TXN_RE.test(tradeNo)) return null;
      const r = await call("GET", `/v3/payments/requests/${tradeNo}/check`, { timeoutMs: 20_000 });
      if (!r.ok) {
        console.error(`[linepay] check 失敗 ${r.message}`);
        return null;
      }
      const c = code(r.data);
      const k = classifyLinepayCheck(c);
      const out: AuthoritativeResult = { state: k.state, needsConfirm: k.needsConfirm, tradeNo, statusText: `check=${c}`, raw: r.data };
      if (k.state === "paid") out.amount = await paidAmount(tradeNo);
      return out;
    },

    async refund({ tradeNo, amount }): Promise<RefundResult> {
      if (!tradeNo || !LINEPAY_TXN_RE.test(tradeNo)) return { kind: "rejected", message: "缺 LINE Pay transactionId" };
      const r = await call("POST", `/v3/payments/${tradeNo}/refund`, { timeoutMs: 45_000, body: { refundAmount: Math.round(amount) } });
      if (!r.ok) return { kind: "unknown", message: r.message };
      const c = code(r.data);
      if (c === "0000") return { kind: "ok", refundNo: String(info(r.data).refundTransactionId ?? ""), raw: r.data };
      return { kind: "rejected", message: `LINE Pay 退款失敗 ${c}：${String(r.data.returnMessage ?? "")}`, raw: r.data };
    },
  };
  return provider;
}

export type LinepayProvider = ReturnType<typeof createLinepayProvider>;
