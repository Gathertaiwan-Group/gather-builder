import { randomBytes } from "node:crypto";
import { parseBody, safeEqual, sha256Hex, taipeiFormat, intAmount } from "./crypto";
import { defaultFetch, fetchWithTimeout, type AuthoritativeResult, type CallbackCheck, type FetchLike, type PaymentProvider } from "./types";

/**
 * 綠界 ECPay 全方位金流（AioCheckOut V5），每個租戶自己的特店。
 * 官方文件：https://developers.ecpay.com.tw/?p=2856（全方位金流介接）
 * - 建單：瀏覽器 POST 表單到 /Cashier/AioCheckOut/V5（我們只產生表單；ChoosePayment=Credit，只開信用卡）。
 * - ReturnURL（server 對 server）：驗 CheckMacValue（SHA256）→ **一律 QueryTradeInfo/V5 回查**，以回查為準。
 *   回應必須是純文字 `1|OK`（https://developers.ecpay.com.tw/?p=2878），否則綠界會重送；我們在要求重送時回 `0|<原因>`。
 * - SimulatePaid=1（廠商後台「模擬付款」）不是真的付款，官方要求不可改變訂單狀態 → 一律不算已付。
 * - 測試特店（官方公開測試值，只在 stage 使用）：MerchantID 3002607 / HashKey pwFHCqoQZGmho4w6 / HashIV EkRm7iFT261dpevs
 *   來源：https://developers.ecpay.com.tw/?p=2856 「介接資訊／測試環境」。
 */
export const ECPAY_STAGE_TEST_MERCHANT = { merchantId: "3002607", hashKey: "pwFHCqoQZGmho4w6", hashIv: "EkRm7iFT261dpevs" } as const;

export function ecpayPaymentBase(stage: boolean) {
  return stage ? "https://payment-stage.ecpay.com.tw" : "https://payment.ecpay.com.tw";
}

/** .NET HttpUtility.UrlEncode 相容（綠界 CheckMacValue 規則）：空白→+、- _ . ! * ( ) 不編碼、~ → %7e、' → %27 */
export function ecpayUrlEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/~/g, "%7E").replace(/'/g, "%27");
}

/** CheckMacValue（金流用 SHA256）：參數 A→Z（不分大小寫）、前後加 HashKey／HashIV、URL encode、轉小寫、SHA256、轉大寫 */
export function ecpayCheckMac(params: Record<string, string>, hashKey: string, hashIv: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${params[k] ?? ""}`).join("&")}&HashIV=${hashIv}`;
  return sha256Hex(ecpayUrlEncode(raw).toLowerCase()).toUpperCase();
}

export function ecpayVerifyMac(params: Record<string, string>, hashKey: string, hashIv: string): boolean {
  const got = (params.CheckMacValue ?? "").trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(got)) return false;
  return safeEqual(got, ecpayCheckMac(params, hashKey, hashIv));
}

/** 綠界回應（QueryTradeInfo）：key=value&…，值沒有 URL encode → 只切第一個 = */
export function parseEcpayKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.trim().split("&")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/**
 * QueryTradeInfo 的 TradeStatus 判讀（https://developers.ecpay.com.tw/?p=2890）：
 * `1` 已付款、`0` 成立未付款、`10200095` 未成立／消費者未完成付款（交易失敗）、`10200047` 查無訂單（stage 實測）；其他一律 unknown。
 * TradeAmt 為交易金額。stage 模擬付款不算（simulated）。
 */
export function classifyEcpayQuery(q: Record<string, string>): AuthoritativeResult {
  const status = (q.TradeStatus ?? "").trim();
  const amount = intAmount(q.TradeAmt);
  const base = { amount, tradeNo: q.TradeNo || undefined, statusText: `TradeStatus=${status || "-"}`, raw: q as Record<string, unknown> };
  if (status === "1") return { ...base, state: "paid" };
  if (status === "0") return { ...base, state: "pending" };
  if (status === "10200095") return { ...base, state: "failed" };
  // 10200047＝查無這筆訂單（客人沒送出付款頁）——2026-10-19 以官方測試特店 3002607 在 stage 實測（scripts/e2e-ecpay-payment-stage.mts）
  if (status === "10200047") return { ...base, state: "pending", statusText: "TradeStatus=10200047（查無訂單：客人未送出付款）" };
  return { ...base, state: "unknown" };
}

export interface EcpayPayCreds {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  stage: boolean;
}

/** 綠界 MerchantTradeNo：英數 ≤ 20（測試特店全部開發者共用，一定要夠隨機） */
export function genEcpayTradeNo(): string {
  const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const ts = Date.now().toString(36).toUpperCase();
  let r = "";
  for (const b of randomBytes(12)) r += ALPHA[b % ALPHA.length];
  return `GB${ts}${r}`.slice(0, 20);
}

/** ItemName 不可含 HTML 與部分符號（綠界會拒絕），上限 400 字 */
const cleanItem = (s: string) => s.replace(/[<>&"'#%]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "商品";

export function createEcpayProvider(creds: EcpayPayCreds, fetchImpl: FetchLike = defaultFetch, now: () => Date = () => new Date()): PaymentProvider & {
  buildCheckoutFields(input: { gatewayOrderNo: string; amount: number; itemName: string; notifyUrl: string; returnUrl: string; cancelUrl: string; expireMinutes?: number }): Record<string, string>;
  queryRaw(gatewayOrderNo: string): Promise<Record<string, string> | null>;
} {
  const base = ecpayPaymentBase(creds.stage);
  const sign = (p: Record<string, string>) => ({ ...p, CheckMacValue: ecpayCheckMac(p, creds.hashKey, creds.hashIv) });

  function buildCheckoutFields(input: { gatewayOrderNo: string; amount: number; itemName: string; notifyUrl: string; returnUrl: string; cancelUrl: string }) {
    return sign({
      MerchantID: creds.merchantId,
      MerchantTradeNo: input.gatewayOrderNo,
      MerchantTradeDate: taipeiFormat(now(), "yyyy/MM/dd HH:mm:ss"),
      PaymentType: "aio",
      TotalAmount: String(Math.round(input.amount)),
      TradeDesc: "online order",
      ItemName: cleanItem(input.itemName),
      ReturnURL: input.notifyUrl,
      ChoosePayment: "Credit",
      EncryptType: "1",
      // 付款完成「返回商店」按鈕（GET，純導頁，不改狀態）
      ClientBackURL: input.returnUrl,
    });
  }

  async function queryRaw(gatewayOrderNo: string): Promise<Record<string, string> | null> {
    const params = sign({ MerchantID: creds.merchantId, MerchantTradeNo: gatewayOrderNo, TimeStamp: String(Math.floor(now().getTime() / 1000)) });
    let res: Response;
    try {
      res = await fetchWithTimeout(fetchImpl, `${base}/Cashier/QueryTradeInfo/V5`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }, 20_000);
    } catch (e) {
      console.error(`[ecpay] 查單連線失敗 ${gatewayOrderNo}`, e instanceof Error ? e.message : e);
      return null;
    }
    const text = await res.text();
    if (!res.ok) {
      console.error(`[ecpay] 查單 HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const q = parseEcpayKv(text);
    // 回應也帶 CheckMacValue：驗不過 = 不可信（可能被中間人改或金鑰錯）
    if (!ecpayVerifyMac(q, creds.hashKey, creds.hashIv)) {
      console.error(`[ecpay] 查單回應 CheckMacValue 不符 ${gatewayOrderNo}: ${text.slice(0, 120)}`);
      return null;
    }
    if (q.MerchantID !== creds.merchantId || q.MerchantTradeNo !== gatewayOrderNo) {
      console.error(`[ecpay] 查單回應的特店／訂單號不符 ${gatewayOrderNo}`);
      return null;
    }
    return q;
  }

  return {
    id: "ecpay",
    sandbox: creds.stage,
    buildCheckoutFields,
    queryRaw,

    async verifyCredentials() {
      // 無副作用：查一筆一定不存在的訂單；回應 CheckMacValue 驗得過＝HashKey／HashIV 正確
      const probe = `GBVERIFY${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
      const params = sign({ MerchantID: creds.merchantId, MerchantTradeNo: probe, TimeStamp: String(Math.floor(now().getTime() / 1000)) });
      try {
        const res = await fetchWithTimeout(fetchImpl, `${base}/Cashier/QueryTradeInfo/V5`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }, 20_000);
        const text = await res.text();
        const q = parseEcpayKv(text);
        if (q.CheckMacValue && ecpayVerifyMac(q, creds.hashKey, creds.hashIv)) return { ok: true };
        return { ok: false, message: `綠界回應無法以這組 HashKey／HashIV 驗證（${text.slice(0, 80)}）——請確認特店編號、金鑰與環境（stage／正式）` };
      } catch (e) {
        return { ok: false, message: `連線失敗：${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async createPayment(input) {
      return { kind: "form", action: `${base}/Cashier/AioCheckOut/V5`, fields: buildCheckoutFields(input) };
    },

    verifyCallback(rawBody, contentType): CallbackCheck {
      const p = parseBody(rawBody, contentType);
      if (!ecpayVerifyMac(p, creds.hashKey, creds.hashIv)) return { ok: false, reason: "CheckMacValueError" };
      if (p.MerchantID !== creds.merchantId) return { ok: false, reason: "MerchantIDError" };
      if (!p.MerchantTradeNo) return { ok: false, reason: "MissingTradeNo" };
      return { ok: true, gatewayOrderNo: p.MerchantTradeNo, merchantId: p.MerchantID, hint: { RtnCode: p.RtnCode, SimulatePaid: p.SimulatePaid } };
    },

    async queryPayment({ gatewayOrderNo }, hint) {
      const q = await queryRaw(gatewayOrderNo);
      if (!q) return null;
      const r = classifyEcpayQuery(q);
      // 第七批審查 L8：callback 標示 SimulatePaid=1（廠商後台模擬付款）→ 不算已付（官方：模擬付款請勿變更訂單狀態）
      if (hint && String(hint.SimulatePaid ?? "") === "1") r.simulated = true;
      // 查單沒有 SimulatePaid 欄位；stage 環境的「已付款」只可能是模擬付款或測試卡，本來就只算 sandbox（不出貨）
      return r;
    },
    // 沒有 refund：綠界信用卡退刷（CreditDetail/DoAction）本版不串，取消已付款訂單時提示到綠界廠商後台人工退款
  };
}
