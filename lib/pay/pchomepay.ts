import { randomBytes } from "node:crypto";

/**
 * PChomePay 支付連（每個租戶自己的商家帳號）。零套件，一律 fetch。
 *
 * 🔴 眉角（gather-landing 實戰）：
 * - sandbox `https://sandbox-api.pchomepay.com.tw`／正式 `https://api.pchomepay.com.tw`；測試金鑰只能打 sandbox、正式只能打正式（交叉 401）。
 * - `POST /v1/token` Basic base64(APP_ID:SECRET) → token，快取到過期前 60 秒；API 回 401 清快取重換一次。
 * - 建單 `POST /v1/payment`（header `pcpay-token`）；最低金額 NT$30。
 * - notify 沒有簽章：絕不信 payload，一律 `GET /v1/payment/{order_id}` 回查權威狀態。
 */
export const PCHOMEPAY_MIN_AMOUNT = 30;
export const PAID_STATUS_CODES = new Set(["S", "00", "1"]);

export function pchomepayBase(sandbox: boolean): string {
  return sandbox ? "https://sandbox-api.pchomepay.com.tw" : "https://api.pchomepay.com.tw";
}

export interface PchomepayCreds {
  /** token 快取鍵（租戶 id）：不同租戶的 token 永遠不會混用 */
  cacheKey: string;
  appId: string;
  secret: string;
  sandbox: boolean;
}

export interface PchomepayQuery {
  status_code?: string;
  amount?: number;
  pay_type?: string;
  raw: Record<string, unknown>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const tokenCache = new Map<string, { token: string; expiresAt: number; fingerprint: string }>();

export function clearPchomepayTokenCache(cacheKey?: string) {
  if (cacheKey) tokenCache.delete(cacheKey);
  else tokenCache.clear();
}

/** 閘道訂單編號：英數、≤ 20 字（PChomePay 規格），GB＋時間 base36＋隨機 */
export function genGatewayOrderNo(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = randomBytes(10);
  let rand = "";
  for (const b of buf) rand += ALPHA[b % ALPHA.length];
  return `GB${ts}${rand}`.slice(0, 20);
}

export function createPchomepayClient(creds: PchomepayCreds, fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
  const base = pchomepayBase(creds.sandbox);
  // 換了 app_id／環境就不能沿用舊 token
  const fingerprint = `${creds.sandbox ? "s" : "p"}:${creds.appId}`;

  async function fetchToken(force = false): Promise<{ ok: true; token: string } | { ok: false; status: number; message: string }> {
    const c = tokenCache.get(creds.cacheKey);
    if (!force && c && c.fingerprint === fingerprint && c.expiresAt > Date.now() + 60_000) return { ok: true, token: c.token };
    let res: Response;
    try {
      res = await fetchImpl(`${base}/v1/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${creds.appId}:${creds.secret}`).toString("base64")}`, "Content-Type": "application/json" },
        cache: "no-store",
      });
    } catch (e) {
      return { ok: false, status: 0, message: `連線失敗：${e instanceof Error ? e.message : String(e)}` };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
    let data: { token?: string; expired_timestamp?: number };
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, message: "token 回應不是 JSON" };
    }
    if (!data.token) return { ok: false, status: res.status, message: "token 回應缺 token" };
    const expiresAt = Number(data.expired_timestamp) > 0 ? Number(data.expired_timestamp) * 1000 : Date.now() + 25 * 60_000;
    tokenCache.set(creds.cacheKey, { token: data.token, expiresAt, fingerprint });
    return { ok: true, token: data.token };
  }

  async function call(path: string, init: { method: "GET" | "POST"; body?: string }): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await fetchToken(attempt > 0);
      if (!t.ok) {
        console.error(`[pchomepay] token 失敗 tenant=${creds.cacheKey} ${t.message}`);
        return null;
      }
      try {
        const res = await fetchImpl(`${base}${path}`, {
          method: init.method,
          headers: { "pcpay-token": t.token, "Content-Type": "application/json" },
          body: init.body,
          cache: "no-store",
        });
        if (res.status === 401 && attempt === 0) {
          tokenCache.delete(creds.cacheKey);
          continue;
        }
        return res;
      } catch (e) {
        console.error(`[pchomepay] API 連線失敗 tenant=${creds.cacheKey}`, e instanceof Error ? e.message : e);
        return null;
      }
    }
    return null;
  }

  return {
    /** 驗證憑證：強制重新換 token（不吃快取） */
    async verify(): Promise<{ ok: true } | { ok: false; message: string }> {
      const t = await fetchToken(true);
      if (t.ok) return { ok: true };
      const hint = t.status === 401 ? "（金鑰錯誤，或測試金鑰／正式金鑰與環境不符）" : "";
      return { ok: false, message: `${t.message}${hint}` };
    },

    async createPayment(input: { orderNo: string; amount: number; itemName: string; itemUrl: string; returnUrl: string; notifyUrl: string; buyerEmail?: string }) {
      const body = JSON.stringify({
        order_id: input.orderNo,
        pay_type: ["CARD", "ATM"],
        amount: Math.round(input.amount),
        return_url: input.returnUrl,
        notify_url: input.notifyUrl,
        items: [{ name: input.itemName.slice(0, 100), url: input.itemUrl }],
        buyer_email: input.buyerEmail || undefined,
        atm_info: { expire_days: 2 },
      });
      const res = await call("/v1/payment", { method: "POST", body });
      if (!res) return null;
      const text = await res.text();
      if (!res.ok) {
        console.error(`[pchomepay] 建單失敗 tenant=${creds.cacheKey} HTTP ${res.status}: ${text.slice(0, 300)}`);
        return null;
      }
      try {
        const data = JSON.parse(text) as { payment_url?: string };
        return data.payment_url ? { paymentUrl: data.payment_url } : null;
      } catch {
        return null;
      }
    },

    /** 權威回查；任何失敗回 null（notify 端回 500 讓對方重試） */
    async queryPayment(orderNo: string): Promise<PchomepayQuery | null> {
      const res = await call(`/v1/payment/${encodeURIComponent(orderNo)}`, { method: "GET" });
      if (!res) return null;
      const text = await res.text();
      if (!res.ok) {
        console.error(`[pchomepay] 查單失敗 tenant=${creds.cacheKey} HTTP ${res.status}: ${text.slice(0, 300)}`);
        return null;
      }
      try {
        const data = JSON.parse(text) as Record<string, unknown>;
        return {
          status_code: data.status_code != null ? String(data.status_code) : undefined,
          amount: data.amount != null && Number.isFinite(Number(data.amount)) ? Number(data.amount) : undefined,
          pay_type: Array.isArray(data.pay_type) ? data.pay_type.map(String).join(",") : data.pay_type != null ? String(data.pay_type) : undefined,
          raw: data,
        };
      } catch {
        return null;
      }
    },
  };
}

export type PchomepayClient = ReturnType<typeof createPchomepayClient>;
