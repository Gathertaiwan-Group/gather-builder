import { aesCbcDecryptHex, aesCbcEncryptHex, buildQuery, intAmount, parseBody, safeEqual, sha256Hex } from "./crypto";
import { defaultFetch, fetchWithTimeout, type AuthoritativeResult, type CallbackCheck, type FetchLike, type PaymentProvider, type RefundResult } from "./types";

/**
 * 藍新金流 NewebPay（每個租戶自己的商店）。官方文件（2026-10 下載）：
 * - 《線上交易─幕前支付技術串接手冊》NDNF-1.2.6：https://www.newebpay.com/website/Page/content/download_api
 * - 《信用卡定期定額串接技術手冊》NDNP-1.0.8（同一頁下載）
 *
 * 加密：TradeInfo＝hex(AES-256-CBC/PKCS7(http_build_query(參數), HashKey, HashIV))；
 *       TradeSha＝SHA256("HashKey=" + key + "&" + TradeInfo + "&HashIV=" + iv) 大寫（§4.1.1–4.1.2，官方範例向量見 tests）。
 * 單筆（MPG）：瀏覽器表單 POST 到 /MPG/mpg_gateway（MerchantID、TradeInfo、TradeSha、Version）。只開信用卡（CREDIT=1）。
 * NotifyURL：先驗 TradeSha（常數時間）→ 解密 → MerchantID 必須相符 → **一律 QueryTradeInfo 回查**（§4.3），以回查為準。
 *   藍新只認 HTTP 200 為通知成功，未收到 200 會重送（手冊 FAQ：Retry 三次）；我們要求重送時回 500。
 * 查單 QueryTradeInfo（Version 1.3）：CheckValue＝SHA256("IV=" + iv + "&Amt=..&MerchantID=..&MerchantOrderNo=..&Key=" + key) 大寫（§4.1.6）；
 *   回應 Result.CheckCode＝SHA256("HashIV=" + iv + "&Amt=..&MerchantID=..&MerchantOrderNo=..&TradeNo=..&HashKey=" + key) 大寫（§4.1.5），必須驗。
 *   TradeStatus：0 未付款、1 付款成功、2 付款失敗、3 取消付款、6 退款。TRA10021＝查無交易（客人沒送出付款頁）。
 *   🔴 TRA10071：1 小時內查詢失敗次數過多會鎖查詢 4 小時——驗證憑證只查一次。
 * 退款：先查 CloseStatus——0/1（未請款／等待提送）→ 取消授權 /API/CreditCard/Cancel（Version 1.0）；
 *   3（請款完成）→ 退款 /API/CreditCard/Close CloseType=2（Version 1.1）；2（請款處理中）→ 稍後再試。
 */
export function newebpayBase(test: boolean) {
  return test ? "https://ccore.newebpay.com" : "https://core.newebpay.com";
}

export interface NewebpayCreds {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  test: boolean;
}

export const newebpayTradeSha = (tradeInfoHex: string, key: string, iv: string) => sha256Hex(`HashKey=${key}&${tradeInfoHex}&HashIV=${iv}`).toUpperCase();

/** QueryTradeInfo 的 CheckValue（§4.1.6）：Amt、MerchantID、MerchantOrderNo 依 A→Z，前 IV= 後 Key= */
export const newebpayCheckValue = (p: { Amt: number | string; MerchantID: string; MerchantOrderNo: string }, key: string, iv: string) =>
  sha256Hex(`IV=${iv}&Amt=${p.Amt}&MerchantID=${p.MerchantID}&MerchantOrderNo=${p.MerchantOrderNo}&Key=${key}`).toUpperCase();

/** 回應的 CheckCode（§4.1.5）：Amt、MerchantID、MerchantOrderNo、TradeNo 依 A→Z，前 HashIV= 後 HashKey= */
export const newebpayCheckCode = (p: { Amt: number | string; MerchantID: string; MerchantOrderNo: string; TradeNo: string }, key: string, iv: string) =>
  sha256Hex(`HashIV=${iv}&Amt=${p.Amt}&MerchantID=${p.MerchantID}&MerchantOrderNo=${p.MerchantOrderNo}&TradeNo=${p.TradeNo}&HashKey=${key}`).toUpperCase();

/** 解密後的 JSON（RespondType=JSON）；容錯：只取第一個 { 到最後一個 }（Dating UP 正式站的修正） */
export function newebpayDecryptJson(hex: string, key: string, iv: string): Record<string, unknown> {
  const plain = aesCbcDecryptHex(hex, key, iv);
  const a = plain.indexOf("{");
  const b = plain.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("解密結果不是 JSON");
  return JSON.parse(plain.slice(a, b + 1)) as Record<string, unknown>;
}

/** QueryTradeInfo 回應判讀 */
export function classifyNewebpayQuery(resp: Record<string, unknown>): AuthoritativeResult {
  const status = String(resp.Status ?? "");
  const r = (resp.Result && typeof resp.Result === "object" ? resp.Result : {}) as Record<string, unknown>;
  if (status === "TRA10021") return { state: "pending", statusText: "TRA10021 查無交易（客人未送出付款）", raw: resp };
  if (status !== "SUCCESS") return { state: "unknown", statusText: `Status=${status}`, raw: resp };
  const ts = String(r.TradeStatus ?? "");
  const base = { amount: intAmount(r.Amt), tradeNo: r.TradeNo ? String(r.TradeNo) : undefined, statusText: `TradeStatus=${ts}`, raw: resp };
  if (ts === "1") return { ...base, state: "paid" };
  if (ts === "0") return { ...base, state: "pending" };
  if (ts === "2" || ts === "3") return { ...base, state: "failed" };
  // 6 退款等：不是「待付款→已付款」的情境，交給人工
  return { ...base, state: "unknown" };
}

export function createNewebpayProvider(creds: NewebpayCreds, fetchImpl: FetchLike = defaultFetch, nowSec: () => number = () => Math.floor(Date.now() / 1000)) {
  const base = newebpayBase(creds.test);
  const enc = (params: Record<string, string | number | undefined>) => aesCbcEncryptHex(buildQuery(params), creds.hashKey, creds.hashIv);

  async function postForm(path: string, fields: Record<string, string>, timeoutMs = 20_000): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetchWithTimeout(fetchImpl, `${base}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }, timeoutMs);
      const text = await res.text();
      if (!res.ok) {
        console.error(`[newebpay] ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        // 部分 API 以 form 格式回傳（例如 period=<加密>）
        const o: Record<string, unknown> = {};
        for (const [k, v] of new URLSearchParams(text)) o[k] = v;
        return Object.keys(o).length ? o : null;
      }
    } catch (e) {
      console.error(`[newebpay] ${path} 失敗`, e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** QueryTradeInfo；驗回應 CheckCode。回 null＝連線失敗／看不懂／CheckCode 不符 */
  async function queryRaw(merchantOrderNo: string, amount: number): Promise<Record<string, unknown> | null> {
    const amt = Math.round(amount);
    const resp = await postForm("/API/QueryTradeInfo", {
      MerchantID: creds.merchantId,
      Version: "1.3",
      RespondType: "JSON",
      CheckValue: newebpayCheckValue({ Amt: amt, MerchantID: creds.merchantId, MerchantOrderNo: merchantOrderNo }, creds.hashKey, creds.hashIv),
      TimeStamp: String(nowSec()),
      MerchantOrderNo: merchantOrderNo,
      Amt: String(amt),
    });
    if (!resp) return null;
    if (String(resp.Status) === "SUCCESS") {
      const r = (resp.Result ?? {}) as Record<string, unknown>;
      const want = newebpayCheckCode({ Amt: String(r.Amt ?? ""), MerchantID: String(r.MerchantID ?? ""), MerchantOrderNo: String(r.MerchantOrderNo ?? ""), TradeNo: String(r.TradeNo ?? "") }, creds.hashKey, creds.hashIv);
      if (!safeEqual(String(r.CheckCode ?? "").toUpperCase(), want)) {
        console.error(`[newebpay] 查單回應 CheckCode 不符 ${merchantOrderNo}`);
        return null;
      }
      if (String(r.MerchantID) !== creds.merchantId || String(r.MerchantOrderNo) !== merchantOrderNo) {
        console.error(`[newebpay] 查單回應的商店／訂單號不符 ${merchantOrderNo}`);
        return null;
      }
    }
    return resp;
  }

  const provider: PaymentProvider & {
    queryRaw: typeof queryRaw;
    /** 定期定額：建立委託表單（NPA-B05） */
    buildPeriodForm(input: PeriodInput): { action: string; fields: Record<string, string> };
    /** 定期定額：解密 Period／period 欄位（建立結果、每期授權通知、修改狀態回應） */
    decryptPeriod(hex: string): Record<string, unknown>;
    /** 定期定額：終止委託（NPA-B051，AlterType=terminate） */
    terminatePeriod(merOrderNo: string, periodNo: string): Promise<{ kind: "ok" | "already" } | { kind: "rejected" | "unknown"; message: string }>;
    /** 定期定額：委託單查詢（MPG/period/query） */
    queryPeriod(merOrderNo: string, periodNo: string): Promise<Record<string, unknown> | null>;
  } = {
    id: "newebpay",
    sandbox: creds.test,
    queryRaw,

    async verifyCredentials() {
      // 無副作用：查一筆不存在的訂單。HashKey／IV 正確時回 TRA10021（查無交易）；CheckValue 錯會回其他錯誤碼
      const probe = `GBVERIFY${Date.now().toString(36).toUpperCase()}`;
      const r = await queryRaw(probe, 30);
      if (!r) return { ok: false, message: "連線失敗或回應無法驗證" };
      const st = String(r.Status ?? "");
      if (st === "TRA10021") return { ok: true };
      return { ok: false, message: `藍新回應 ${st}：${String(r.Message ?? "")}（請確認商店代號、HashKey／HashIV 與環境）` };
    },

    async createPayment(input) {
      if (!/^[A-Za-z0-9_]{1,30}$/.test(input.gatewayOrderNo)) return null;
      const tradeInfo = enc({
        MerchantID: creds.merchantId,
        RespondType: "JSON",
        TimeStamp: nowSec(),
        Version: "2.0",
        MerchantOrderNo: input.gatewayOrderNo,
        Amt: Math.round(input.amount),
        ItemDesc: input.itemName.replace(/[<>"'&]/g, " ").slice(0, 50) || "訂單",
        ReturnURL: input.returnUrl,
        NotifyURL: input.notifyUrl,
        ClientBackURL: input.cancelUrl,
        Email: input.buyerEmail,
        LoginType: 0,
        CREDIT: 1,
      });
      return { kind: "form", action: `${base}/MPG/mpg_gateway`, fields: { MerchantID: creds.merchantId, TradeInfo: tradeInfo, TradeSha: newebpayTradeSha(tradeInfo, creds.hashKey, creds.hashIv), Version: "2.0" } };
    },

    verifyCallback(rawBody, contentType): CallbackCheck {
      const p = parseBody(rawBody, contentType);
      if (!p.TradeInfo || !p.TradeSha) return { ok: false, reason: "missing" };
      if (!safeEqual(p.TradeSha.trim().toUpperCase(), newebpayTradeSha(p.TradeInfo.trim(), creds.hashKey, creds.hashIv))) return { ok: false, reason: "TradeSha" };
      if (p.MerchantID && p.MerchantID !== creds.merchantId) return { ok: false, reason: "MerchantID" };
      let data: Record<string, unknown>;
      try {
        data = newebpayDecryptJson(p.TradeInfo, creds.hashKey, creds.hashIv);
      } catch {
        return { ok: false, reason: "decrypt" };
      }
      const r = (data.Result ?? {}) as Record<string, unknown>;
      if (String(r.MerchantID ?? "") !== creds.merchantId) return { ok: false, reason: "MerchantID" };
      const no = String(r.MerchantOrderNo ?? "");
      if (!no) return { ok: false, reason: "MerchantOrderNo" };
      return { ok: true, gatewayOrderNo: no, merchantId: creds.merchantId, hint: { status: data.Status } };
    },

    async queryPayment({ gatewayOrderNo, amount }) {
      const r = await queryRaw(gatewayOrderNo, amount);
      return r ? classifyNewebpayQuery(r) : null;
    },

    async refund({ gatewayOrderNo, amount }): Promise<RefundResult> {
      const q = await queryRaw(gatewayOrderNo, amount);
      if (!q || String(q.Status) !== "SUCCESS") return { kind: "unknown", message: "退款前回查失敗，請稍後再試" };
      const r = (q.Result ?? {}) as Record<string, unknown>;
      if (String(r.TradeStatus) !== "1") return { kind: "rejected", message: `藍新交易狀態 TradeStatus=${String(r.TradeStatus)}，不是已付款，無法退款` };
      if (r.BackStatus != null && String(r.BackStatus) !== "0" && String(r.BackStatus) !== "") return { kind: "rejected", message: `藍新已有退款紀錄（BackStatus=${String(r.BackStatus)}），請到藍新後台確認` };
      const close = String(r.CloseStatus ?? "");
      const amt = Math.round(amount);
      let path: string;
      let data: Record<string, string | number>;
      if (close === "0" || close === "1") {
        path = "/API/CreditCard/Cancel";
        data = { RespondType: "JSON", Version: "1.0", Amt: amt, MerchantOrderNo: gatewayOrderNo, IndexType: 1, TimeStamp: nowSec() };
      } else if (close === "3") {
        path = "/API/CreditCard/Close";
        data = { RespondType: "JSON", Version: "1.1", Amt: amt, MerchantOrderNo: gatewayOrderNo, TimeStamp: nowSec(), IndexType: 1, CloseType: 2 };
      } else {
        return { kind: "rejected", message: `藍新請款處理中（CloseStatus=${close}），請稍後再退款` };
      }
      const resp = await postForm(path, { MerchantID_: creds.merchantId, PostData_: enc(data) }, 30_000);
      if (!resp) return { kind: "unknown", message: "退款請求逾時或回應無法辨識（請到藍新後台確認，不會自動重送）" };
      if (String(resp.Status) === "SUCCESS") return { kind: "ok", refundNo: String(((resp.Result ?? {}) as Record<string, unknown>).TradeNo ?? ""), raw: resp };
      return { kind: "rejected", message: `藍新退款失敗 ${String(resp.Status)}：${String(resp.Message ?? "")}`, raw: resp };
    },

    buildPeriodForm(input: PeriodInput) {
      const postData = enc({
        RespondType: "JSON",
        TimeStamp: nowSec(),
        Version: "1.5",
        LangType: "zh-Tw",
        MerOrderNo: input.merOrderNo,
        ProdDesc: input.prodDesc.replace(/[^\p{L}\p{N} _]/gu, " ").slice(0, 100) || "subscription",
        PeriodAmt: Math.round(input.amount),
        PeriodType: input.periodType,
        PeriodPoint: input.periodPoint,
        PeriodStartType: input.startType,
        PeriodTimes: input.times,
        ReturnURL: input.returnUrl,
        NotifyURL: input.notifyUrl,
        BackURL: input.backUrl,
        PayerEmail: input.payerEmail,
        EmailModify: 0,
        PaymentInfo: "N",
        OrderInfo: "N",
      });
      return { action: `${base}/MPG/period`, fields: { MerchantID_: creds.merchantId, PostData_: postData } };
    },

    decryptPeriod(hex: string) {
      return newebpayDecryptJson(hex, creds.hashKey, creds.hashIv);
    },

    async terminatePeriod(merOrderNo, periodNo) {
      const resp = await (async () => {
        try {
          const res = await fetchWithTimeout(
            fetchImpl,
            `${base}/MPG/period/AlterStatus`,
            { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ MerchantID_: creds.merchantId, PostData_: enc({ RespondType: "JSON", Version: "1.0", MerOrderNo: merOrderNo, PeriodNo: periodNo, AlterType: "terminate", TimeStamp: nowSec() }) }).toString() },
            30_000,
          );
          const text = await res.text();
          // 回應可能是 JSON {period: <加密>} 或 form period=<加密>
          let hex = "";
          try {
            const j = JSON.parse(text) as Record<string, unknown>;
            hex = String(j.period ?? j.Period ?? "");
          } catch {
            hex = new URLSearchParams(text).get("period") ?? "";
          }
          return hex ? newebpayDecryptJson(hex, creds.hashKey, creds.hashIv) : null;
        } catch (e) {
          console.error("[newebpay] AlterStatus 失敗", e instanceof Error ? e.message : e);
          return null;
        }
      })();
      if (!resp) return { kind: "unknown", message: "終止委託逾時或回應無法辨識，稍後會重試" };
      const st = String(resp.Status ?? "");
      if (st === "SUCCESS") return { kind: "ok" };
      // PER10065＝已是終止狀態無法重複終止（冪等：視同已終止）；PER10072 終止狀態無法修改；PER10075 委託已到期
      if (st === "PER10065" || st === "PER10072" || st === "PER10075") return { kind: "already" };
      return { kind: "rejected", message: `藍新終止委託失敗 ${st}：${String(resp.Message ?? "")}${st === "PER10074" ? "（此 API 需向藍新申請開通）" : ""}` };
    },

    async queryPeriod(merOrderNo, periodNo) {
      const resp = await postForm("/MPG/period/query", { MerchantID_: creds.merchantId, PostData_: enc({ RespondType: "JSON", Version: "1.0", MerOrderNo: merOrderNo, PeriodNo: periodNo, TimeStamp: nowSec() }) });
      if (!resp) return null;
      const hex = String(resp.period ?? resp.Period ?? "");
      if (hex) {
        try {
          return newebpayDecryptJson(hex, creds.hashKey, creds.hashIv);
        } catch {
          return null;
        }
      }
      return resp;
    },
  };
  return provider;
}

export interface PeriodInput {
  merOrderNo: string;
  prodDesc: string;
  amount: number;
  periodType: "M" | "Y";
  /** M：01–31（每月幾號）；Y：MMDD */
  periodPoint: string;
  /** 1＝10 元驗證後依週期扣款（試用期）、2＝立即扣第一期 */
  startType: 1 | 2;
  times: number;
  returnUrl: string;
  notifyUrl: string;
  backUrl: string;
  payerEmail: string;
}

export type NewebpayProvider = ReturnType<typeof createNewebpayProvider>;
