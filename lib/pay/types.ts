/**
 * 金流 provider 的共用型別（葉節點：不 import 任何 services／store，避免循環 import 造成 TDZ）。
 *
 * 每一家 provider 都實作 PaymentProvider。安全不變式（見 docs/ARCHITECTURE.md「金流 provider」）：
 * 1. callback payload 一律不信：先驗簽章（常數時間比較），再用 queryPayment 權威回查，以回查結果為準。
 * 2. 金額（權威金額 = 付款紀錄 = 訂單總額）、訂單號、租戶三重比對。
 * 3. 條件式轉換，只有真正轉換那次跑副作用；終結狀態不被覆蓋。
 * 4. 無法辨識的狀態 → unknown：不標記、讓對方重試、警示店主。
 * 5. 回查環境必須等於建單環境（sandbox／正式）。
 */

export const PROVIDER_IDS = ["pchomepay", "newebpay", "ecpay", "linepay", "blackcat", "payuni"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  pchomepay: "PChomePay 支付連",
  newebpay: "藍新金流 NewebPay",
  ecpay: "綠界科技 ECPay",
  linepay: "LINE Pay",
  blackcat: "黑貓 PAY",
  payuni: "PAYUNi 統一金流",
};

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

/** 線上付款最低金額（所有 provider 一致，沿用 PChomePay 的 NT$30） */
export const ONLINE_MIN_AMOUNT = 30;

export type PayState = "paid" | "failed" | "pending" | "unknown";

/** 權威回查結果（只來自 provider 的 API 回應，絕不來自 callback payload） */
export interface AuthoritativeResult {
  state: PayState;
  /** 客人實際付款的毛額（新台幣整數）；缺 → 不標記付款（回 retry） */
  amount?: number;
  /** provider 的交易序號 */
  tradeNo?: string;
  /** 狀態原文（log／警示用） */
  statusText: string;
  /** 綠界 stage「模擬付款」等：不是真的付款 */
  simulated?: boolean;
  /** LINE Pay：已授權但尚未 confirm（需要 server 端以 DB 金額 confirm） */
  needsConfirm?: boolean;
  raw: Record<string, unknown>;
}

export type CreateResult =
  | { kind: "redirect"; url: string; tradeNo?: string }
  | { kind: "form"; action: string; fields: Record<string, string>; tradeNo?: string };

export interface CreatePaymentInput {
  /** 我們產生的閘道訂單編號（唯一、英數） */
  gatewayOrderNo: string;
  amount: number;
  itemName: string;
  /** 客人付款後瀏覽器導回（訂單頁或我們的 return 端點；不在 return 上改任何狀態） */
  returnUrl: string;
  /** 伺服器對伺服器通知（帶 tenantId） */
  notifyUrl: string;
  /** 客人放棄付款時回到的頁面 */
  cancelUrl: string;
  buyerEmail?: string;
  /** 付款期限（分鐘），provider 有支援才帶 */
  expireMinutes?: number;
}

export type RefundResult =
  | { kind: "ok"; refundNo?: string; raw: Record<string, unknown> }
  /** 確定失敗（例如已退過、超過可退金額、狀態不允許） */
  | { kind: "rejected"; message: string; raw?: Record<string, unknown> }
  /** 不知道結果（逾時、看不懂）：不重送，回查後再決定 */
  | { kind: "unknown"; message: string; raw?: Record<string, unknown> };

/** callback 的簽章驗證結果：只用來取「查詢鍵」，狀態一律以回查為準 */
export type CallbackCheck =
  | { ok: true; gatewayOrderNo: string; merchantId?: string; hint?: Record<string, unknown> }
  | { ok: false; reason: string };

export interface PaymentProvider {
  id: ProviderId;
  sandbox: boolean;
  /** 無副作用的憑證檢查（官方有提供才做；沒有就只檢查格式並說明） */
  verifyCredentials(): Promise<{ ok: true; note?: string } | { ok: false; message: string }>;
  createPayment(input: CreatePaymentInput): Promise<CreateResult | null>;
  /** 驗 callback 簽章；沒有 server callback 的 provider（LINE Pay）不實作 */
  verifyCallback?(rawBody: string, contentType: string): CallbackCheck;
  /** 權威回查；連線失敗／看不懂回 null（呼叫端回 retry、累計失敗次數） */
  /**
   * callbackHint：已驗簽 callback 的補充資料（只有黑貓用：實收金額只在 APN 的 payment_detail.pay_amount，回查沒有）。
   * 狀態一律以回查為準。
   */
  queryPayment(p: { gatewayOrderNo: string; amount: number; tradeNo?: string | null }, callbackHint?: Record<string, unknown>): Promise<AuthoritativeResult | null>;
  /** 全額退款（provider 有退款 API 才有） */
  refund?(p: { gatewayOrderNo: string; amount: number; tradeNo?: string | null }): Promise<RefundResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export const defaultFetch: FetchLike = (u, i) => fetch(u, { ...i, cache: "no-store" });

/** 有逾時的 fetch（逾時丟錯，呼叫端當成「不知道結果」） */
export async function fetchWithTimeout(f: FetchLike, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await f(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** 付款方式是否為線上金流（＝provider id） */
export const isOnlineMethod = (m: string): m is ProviderId => isProviderId(m);

/** 有串退款 API 的 provider（黑貓另需設定退刷密碼）；其他家維持「提示到商家後台人工退款」 */
export const REFUND_CAPABLE: ReadonlySet<ProviderId> = new Set<ProviderId>(["newebpay", "linepay", "payuni", "blackcat"]);
