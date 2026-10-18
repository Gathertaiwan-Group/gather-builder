import { aesGcmDecryptHex, aesGcmEncryptHex, buildQuery, intAmount, parseBody, safeEqual, sha256Hex } from "./crypto";
import { defaultFetch, fetchWithTimeout, type AuthoritativeResult, type CallbackCheck, type FetchLike, type PaymentProvider, type RefundResult } from "./types";

/**
 * PAYUNi 統一金流（每個租戶自己的商店）。官方文件（公開，2026-10 讀取）：https://docs.payuni.com.tw/web/#/7/24
 * - 加解密（https://docs.payuni.com.tw/web/#/7/29）：EncryptInfo＝bin2hex( base64(AES-256-GCM(http_build_query(資料), HashKey, HashIV)) + ":::" + base64(tag) )；
 *   HashInfo＝strtoupper(sha256(HashKey + EncryptInfo + HashIV))。IV 是 16 字的 HashIV。官方範例向量見 tests。
 * - 整合式支付頁 UPP（https://docs.payuni.com.tw/web/#/7/34）：瀏覽器表單 POST 到 /api/upp（MerID、Version 2.0、EncryptInfo、HashInfo）；
 *   MerTradeNo ≤ 25 [A-Za-z0-9_-]、10 分鐘內不可重複；NotifyURL 只能 80／443 port；只開信用卡（Credit=1）。
 * - NotifyURL：外層 Status＝SUCCESS 只表示請求有效、**不是付款結果**。先驗 HashInfo（常數時間）→ 解密 → MerID 相符 →
 *   **一律交易查詢 /api/trade/query（Version 2.0，https://docs.payuni.com.tw/web/#/7/164）回查**，以回查為準。
 *   官方文件沒有規定 Notify 的回應格式與重送機制（103 頁皆查無）；我們處理完回 200 純文字 OK，要求重送時回 500。
 * - 查詢回應：Result 陣列；TradeStatus 0 取號成功／9 未付款／1 已付款／2 付款失敗／3 付款取消／4 交易逾期／8 訂單待確認；
 *   DataSource B＝處理中未完整（不可判定失敗）。錯誤碼（https://docs.payuni.com.tw/web/#/7/30）：QUERY03001 查無符合訂單資料（客人未付款）、
 *   QUERY01002 Hash 比對不符、QUERY01005 查無商店。
 * - 退款：信用卡已請款（CloseStatus=2）→ /api/trade/close CloseType=2（https://docs.payuni.com.tw/web/#/7/38）；
 *   尚未請款（CloseStatus 9 未申請）→ /api/trade/cancel 取消授權（https://docs.payuni.com.tw/web/#/7/39）；請款處理中 → 稍後再試。
 * - 測試區 https://sandbox-api.payuni.com.tw 需要在 PAYUNi 測試平台註冊會員並建立商店（無公開測試商店）。
 */
export function payuniBase(sandbox: boolean) {
  return sandbox ? "https://sandbox-api.payuni.com.tw" : "https://api.payuni.com.tw";
}

export interface PayuniCreds {
  merId: string;
  hashKey: string;
  hashIv: string;
  sandbox: boolean;
}

export const payuniHashInfo = (encryptInfo: string, key: string, iv: string) => sha256Hex(`${key}${encryptInfo}${iv}`).toUpperCase();

/** 解析解密後的資料：query string（含 Result[0][X] 形式）或 JSON；回扁平物件，Result 取第一筆 */
export function parsePayuniPayload(plain: string): Record<string, unknown> {
  const t = plain.trim();
  if (t.startsWith("{")) {
    const o = JSON.parse(t) as Record<string, unknown>;
    const res = Array.isArray(o.Result) ? (o.Result[0] as Record<string, unknown>) : o.Result && typeof o.Result === "object" ? (Object.values(o.Result as object)[0] as Record<string, unknown>) : null;
    return res ? { ...o, ...res, Status: o.Status ?? res.Status, Message: o.Message ?? res.Message } : o;
  }
  const top: Record<string, unknown> = {};
  const first: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(t)) {
    const m = /^Result\[0\]\[([^\]]+)\]$/.exec(k);
    if (m) first[m[1]!] = v;
    else if (!k.startsWith("Result[")) top[k] = v;
  }
  // 外層的 Status／Message 優先（查詢本身的狀態）
  return { ...first, ...top };
}

export function classifyPayuniQuery(q: Record<string, unknown>): AuthoritativeResult {
  const status = String(q.Status ?? "");
  if (status === "QUERY03001") return { state: "pending", statusText: "QUERY03001 查無符合訂單資料（客人未送出付款）", raw: q };
  if (status !== "SUCCESS") return { state: "unknown", statusText: `Status=${status}`, raw: q };
  const ts = String(q.TradeStatus ?? "");
  const ds = String(q.DataSource ?? "A");
  const base = { amount: intAmount(q.TradeAmt), tradeNo: q.TradeNo ? String(q.TradeNo) : undefined, statusText: `TradeStatus=${ts} DataSource=${ds}`, raw: q };
  if (ts === "1" && ds === "A") return { ...base, state: "paid" };
  if (ts === "1") return { ...base, state: "pending" }; // 處理中未完整：等完整資料
  if (ts === "0" || ts === "9" || ts === "8") return { ...base, state: "pending" };
  if ((ts === "2" || ts === "3" || ts === "4") && ds === "A") return { ...base, state: "failed" };
  if (ts === "2" || ts === "3" || ts === "4") return { ...base, state: "pending" };
  return { ...base, state: "unknown" };
}

export function createPayuniProvider(creds: PayuniCreds, fetchImpl: FetchLike = defaultFetch, nowSec: () => number = () => Math.floor(Date.now() / 1000)) {
  const base = payuniBase(creds.sandbox);
  const enc = (data: Record<string, string | number | undefined>) => aesGcmEncryptHex(buildQuery(data), creds.hashKey, creds.hashIv);
  const envelope = (data: Record<string, string | number | undefined>, version: string) => {
    const e = enc({ MerID: creds.merId, ...data });
    return { MerID: creds.merId, Version: version, EncryptInfo: e, HashInfo: payuniHashInfo(e, creds.hashKey, creds.hashIv) };
  };

  /** 呼叫 API，驗回應 HashInfo、解密。回 null＝連線失敗或回應不可信 */
  async function call(path: string, data: Record<string, string | number | undefined>, version: string): Promise<Record<string, unknown> | null> {
    let text: string;
    try {
      const res = await fetchWithTimeout(fetchImpl, `${base}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "payuni" }, body: new URLSearchParams(envelope(data, version)).toString() }, 25_000);
      text = await res.text();
      if (!res.ok) {
        console.error(`[payuni] ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
    } catch (e) {
      console.error(`[payuni] ${path} 失敗`, e instanceof Error ? e.message : e);
      return null;
    }
    const outer = parseBody(text, text.trim().startsWith("{") ? "application/json" : "");
    if (!outer.EncryptInfo) {
      // 錯誤時可能只有外層 Status（未加密）
      return outer.Status ? { Status: outer.Status, Message: outer.Message } : null;
    }
    if (!outer.HashInfo || !safeEqual(outer.HashInfo.toUpperCase(), payuniHashInfo(outer.EncryptInfo, creds.hashKey, creds.hashIv))) {
      console.error(`[payuni] ${path} 回應 HashInfo 不符`);
      return null;
    }
    try {
      const inner = parsePayuniPayload(aesGcmDecryptHex(outer.EncryptInfo, creds.hashKey, creds.hashIv));
      return { ...inner, Status: inner.Status ?? outer.Status };
    } catch {
      console.error(`[payuni] ${path} 回應解密失敗`);
      return null;
    }
  }

  async function queryRaw(merTradeNo: string) {
    const q = await call("/api/trade/query", { MerTradeNo: merTradeNo, Timestamp: nowSec() }, "2.0");
    if (q && String(q.Status) === "SUCCESS" && q.MerTradeNo && String(q.MerTradeNo) !== merTradeNo) {
      console.error(`[payuni] 查詢回應的訂單號不符 ${merTradeNo}`);
      return null;
    }
    return q;
  }

  const provider: PaymentProvider & { queryRaw: typeof queryRaw } = {
    id: "payuni",
    sandbox: creds.sandbox,
    queryRaw,

    async verifyCredentials() {
      // 無副作用：查一筆不存在的訂單；Hash 正確時回 QUERY03001（查無訂單）
      const r = await queryRaw(`GBVERIFY${Date.now().toString(36).toUpperCase()}`);
      if (!r) return { ok: false, message: "連線失敗或回應無法驗證（HashKey／HashIV 可能不正確）" };
      const st = String(r.Status ?? "");
      if (st === "QUERY03001") return { ok: true };
      return { ok: false, message: `PAYUNi 回應 ${st}：${String(r.Message ?? "")}（請確認商店代號、HashKey／HashIV 與環境）` };
    },

    async createPayment(input) {
      if (!/^[A-Za-z0-9_-]{1,25}$/.test(input.gatewayOrderNo)) return null;
      try {
        const u = new URL(input.notifyUrl);
        if (u.port && u.port !== "80" && u.port !== "443") return null; // NotifyURL 只能 80／443（否則整筆被拒）
      } catch {
        return null;
      }
      const fields = envelope(
        {
          MerTradeNo: input.gatewayOrderNo,
          TradeAmt: Math.round(input.amount),
          Timestamp: nowSec(),
          ProdDesc: input.itemName.slice(0, 500),
          ReturnURL: input.returnUrl,
          NotifyURL: input.notifyUrl,
          BackURL: input.cancelUrl,
          UsrMail: input.buyerEmail,
          Credit: 1,
        },
        "2.0",
      );
      return { kind: "form", action: `${base}/api/upp`, fields };
    },

    verifyCallback(rawBody, contentType): CallbackCheck {
      const p = parseBody(rawBody, contentType);
      if (!p.EncryptInfo || !p.HashInfo) return { ok: false, reason: "missing" };
      if (!safeEqual(p.HashInfo.trim().toUpperCase(), payuniHashInfo(p.EncryptInfo.trim(), creds.hashKey, creds.hashIv))) return { ok: false, reason: "HashInfo" };
      if (p.MerID && p.MerID !== creds.merId) return { ok: false, reason: "MerID" };
      let d: Record<string, unknown>;
      try {
        d = parsePayuniPayload(aesGcmDecryptHex(p.EncryptInfo.trim(), creds.hashKey, creds.hashIv));
      } catch {
        return { ok: false, reason: "decrypt" };
      }
      if (d.MerID != null && String(d.MerID) !== creds.merId) return { ok: false, reason: "MerID" };
      const no = String(d.MerTradeNo ?? "");
      if (!no) return { ok: false, reason: "MerTradeNo" };
      return { ok: true, gatewayOrderNo: no, merchantId: creds.merId, hint: { TradeStatus: d.TradeStatus } };
    },

    async queryPayment({ gatewayOrderNo }) {
      const q = await queryRaw(gatewayOrderNo);
      return q ? classifyPayuniQuery(q) : null;
    },

    async refund({ gatewayOrderNo, amount, tradeNo }): Promise<RefundResult> {
      const q = await queryRaw(gatewayOrderNo);
      if (!q || String(q.Status) !== "SUCCESS") return { kind: "unknown", message: "退款前回查失敗，請稍後再試" };
      if (String(q.TradeStatus) !== "1") return { kind: "rejected", message: `PAYUNi 訂單狀態 TradeStatus=${String(q.TradeStatus)}，不是已付款` };
      if (q.RefundStatus && ["1", "2", "8"].includes(String(q.RefundStatus))) return { kind: "rejected", message: `PAYUNi 已有退款（RefundStatus=${String(q.RefundStatus)}），請到 PAYUNi 後台確認` };
      const uni = String(q.TradeNo ?? tradeNo ?? "");
      if (!uni) return { kind: "unknown", message: "缺 UNi 序號" };
      const close = String(q.CloseStatus ?? "");
      let r: Record<string, unknown> | null;
      if (close === "9" || close === "") r = await call("/api/trade/cancel", { TradeNo: uni, Timestamp: nowSec() }, "1.0");
      else if (close === "2") r = await call("/api/trade/close", { TradeNo: uni, Timestamp: nowSec(), CloseType: 2, TradeAmt: Math.round(amount) }, "1.0");
      else return { kind: "rejected", message: `PAYUNi 請款處理中（CloseStatus=${close}），請稍後再退款` };
      if (!r) return { kind: "unknown", message: "退款請求逾時或回應無法辨識（請到 PAYUNi 後台確認，不會自動重送）" };
      if (String(r.Status) === "SUCCESS") return { kind: "ok", raw: r };
      return { kind: "rejected", message: `PAYUNi 退款失敗 ${String(r.Status)}：${String(r.Message ?? "")}`, raw: r };
    },
  };
  return provider;
}
