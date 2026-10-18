import { createHash } from "node:crypto";
import { taipeiYmd, type AllowanceInput, type InvoiceProvider, type IssueInput, type ProviderFail, type ProviderResult } from "./provider";

/**
 * Amego（光貿）電子發票 adapter。依官方文件 https://invoice.amego.tw/api_doc/ ：
 *   開立 POST /json/f0401　作廢 POST /json/f0501（body 是陣列）　折讓 POST /json/g0401（陣列）　反查 POST /json/invoice_query
 *   form body { invoice: 賣方統編, data: <JSON 字串>, time: <unix 秒>, sign: md5(data + time + appKey) }
 *
 * 🔴 已知眉角（快樂手／小時光／Realreal 實戰，見 docs/ARCHITECTURE.md「發票」）：
 * 1. 每個回應都是 HTTP 200，只能看 body 的 code（0 成功）。
 * 2. 簽章的 data 必須是送出去的同一個字串（只 stringify 一次）。
 * 3. Amego 用來源 IP 白名單，Vercel 出口 IP 浮動 → 正式使用一定要經固定 IP 中繼（env AMEGO_RELAY_URL＋AMEGO_RELAY_SECRET）。
 * 4. 「解得開的 JSON」不等於 Amego 的回應：中繼自己的 {"error":...}、WAF 擋頁都沒有數字 code →
 *    一律當「暫時失敗可重試」，絕不當永久失敗（小時光曾因此卡住 5 張發票三天）。
 * 5. code 71 對 invoice_query 是「確定沒開過」（正常結果），3040171 是 OrderId 重複（已經開過 → 反查認回）。
 */

export const AMEGO_OFFICIAL = "https://invoice-api.amego.tw";
export const AMEGO_OK = 0;
export const AMEGO_NOT_FOUND = 71;
export const AMEGO_IP_DENIED = 14;
export const AMEGO_DUPLICATE_ORDER = 3040171;
const TIMEOUT_MS = 20_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AmegoConfig {
  sellerTaxId: string;
  appKey: string;
  /** 固定 IP 中繼（沒設＝直連，正式使用前必須設） */
  relayUrl?: string | null;
  relaySecret?: string | null;
}

export function amegoRelayFromEnv(): { relayUrl: string | null; relaySecret: string | null } {
  return { relayUrl: process.env.AMEGO_RELAY_URL?.trim() || null, relaySecret: process.env.AMEGO_RELAY_SECRET?.trim() || null };
}

export function amegoSign(data: string, time: number, appKey: string): string {
  return createHash("md5").update(`${data}${time}${appKey}`).digest("hex");
}

type AmegoBody = { code: number; msg?: string; [k: string]: unknown };

/**
 * 解析回應：只有「有數字 code 的 JSON」才算 Amego 回應；其他（HTTP 非 200、不是 JSON、中繼／WAF 的 JSON）都是可重試的暫時失敗。
 */
export function parseAmegoResponse(status: number, text: string): { ok: true; body: AmegoBody } | ProviderFail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, retryable: true, message: `非 Amego 回應（不是 JSON）http=${status} body=${text.slice(0, 160)}` };
  }
  const code = (parsed as { code?: unknown } | null)?.code;
  const numeric = typeof code === "number" || (typeof code === "string" && /^\d+$/.test(code));
  if (!numeric) return { ok: false, retryable: true, message: `非 Amego 回應（沒有數字 code，可能是中繼或 WAF）http=${status} body=${text.slice(0, 160)}` };
  return { ok: true, body: { ...(parsed as Record<string, unknown>), code: Number(code) } as AmegoBody };
}

function fail(body: AmegoBody, what: string): ProviderFail {
  // 14 = IP 未被允許（中繼沒設或白名單沒加）→ 設定好就會成功，算可重試
  return { ok: false, retryable: body.code === AMEGO_IP_DENIED, code: body.code, message: `${what}失敗 code=${body.code} ${body.msg ?? ""}`.trim(), raw: body };
}

export function createAmegoProvider(cfg: AmegoConfig, fetchImpl: FetchLike = (u, i) => fetch(u, i)): InvoiceProvider {
  const base = (cfg.relayUrl || AMEGO_OFFICIAL).replace(/\/+$/, "");
  const viaRelay = !!cfg.relayUrl && base !== AMEGO_OFFICIAL;

  async function post(path: string, payload: unknown): Promise<{ ok: true; body: AmegoBody } | ProviderFail> {
    const data = JSON.stringify(payload); // 🔴 只序列化一次，簽章與 body 共用
    const time = Math.floor(Date.now() / 1000);
    const body = new URLSearchParams({ invoice: cfg.sellerTaxId, data, time: String(time), sign: amegoSign(data, time, cfg.appKey) });
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // 只在確定走中繼時才送中繼密鑰（不送給第三方）
          ...(viaRelay && cfg.relaySecret ? { "x-relay-secret": cfg.relaySecret } : {}),
        },
        body: body.toString(),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      const cause = e instanceof Error && (e as { cause?: unknown }).cause;
      return { ok: false, retryable: true, message: `連線失敗：${e instanceof Error ? e.message : String(e)}${cause instanceof Error ? `（${cause.message}）` : ""}` };
    }
    return parseAmegoResponse(res.status, text);
  }

  const buyerFields = (input: IssueInput) => {
    const r = input.request;
    if (r.type === "b2b") return { BuyerIdentifier: r.taxId, BuyerName: r.title };
    const carrier: Record<string, string> = {};
    if (r.type === "donation") carrier.NPOBAN = r.loveCode;
    if (r.type === "mobile") Object.assign(carrier, { CarrierType: "3J0002", CarrierId1: r.carrier, CarrierId2: r.carrier });
    if (r.type === "certificate") Object.assign(carrier, { CarrierType: "CQ0001", CarrierId1: r.carrier, CarrierId2: r.carrier });
    // member → 不帶載具欄位 = Amego 會員載具（以 Email 通知）
    return { BuyerIdentifier: "0000000000", BuyerName: input.buyerName.slice(0, 60) || "消費者", ...carrier };
  };

  return {
    id: "amego",
    async verify() {
      const r = await post("/json/invoice_query", { type: "order", order_id: `GBVERIFY${Date.now()}` });
      if (!r.ok) return r;
      if (r.body.code === AMEGO_OK || r.body.code === AMEGO_NOT_FOUND) return { ok: true };
      return fail(r.body, "驗證");
    },

    async issue(input) {
      const total = Math.round(input.total);
      const ProductItem = input.items.map((it) => ({
        Description: it.name.slice(0, 256) || "商品",
        Quantity: it.qty,
        UnitPrice: Math.round(it.unitPrice),
        Amount: Math.round(it.unitPrice) * it.qty,
        Remark: "",
        TaxType: 1,
      }));
      const isB2B = input.request.type === "b2b";
      // 官方「含稅商品金額計算邏輯」：不打統編 TaxAmount=0；打統編 TaxAmount = Sales − Round(Sales/1.05)
      const taxAmount = isB2B ? total - Math.round(total / 1.05) : 0;
      const r = await post("/json/f0401", {
        OrderId: input.orderNo,
        ...buyerFields(input),
        BuyerEmailAddress: input.buyerEmail,
        ProductItem,
        SalesAmount: total - taxAmount,
        FreeTaxSalesAmount: 0,
        ZeroTaxSalesAmount: 0,
        TaxType: 1,
        TaxRate: 0.05,
        TaxAmount: taxAmount,
        TotalAmount: total,
      });
      if (!r.ok) return r;
      if (r.body.code === AMEGO_DUPLICATE_ORDER) return { ok: false, retryable: false, duplicate: true, code: r.body.code, message: `OrderId 重複（${input.orderNo} 已開過發票）`, raw: r.body };
      if (r.body.code !== AMEGO_OK) return fail(r.body, "開立");
      const no = String(r.body.invoice_number ?? "");
      if (!no) return { ok: false, retryable: true, message: "code 0 但沒有 invoice_number（無法確認，先反查）", raw: r.body };
      const t = Number(r.body.invoice_time);
      return { ok: true, invoiceNo: no, randomNumber: r.body.random_number ? String(r.body.random_number) : null, invoiceDate: taipeiYmd(Number.isFinite(t) && t > 0 ? new Date(t * 1000) : new Date()), raw: r.body };
    },

    async query(orderNo) {
      const r = await post("/json/invoice_query", { type: "order", order_id: orderNo });
      if (!r.ok) return r;
      if (r.body.code === AMEGO_NOT_FOUND) return { ok: true, found: false };
      if (r.body.code !== AMEGO_OK) return { ...fail(r.body, "反查"), retryable: true };
      const d = (r.body.data ?? {}) as Record<string, unknown>;
      const no = String(d.invoice_number ?? "");
      if (!no) return { ok: false, retryable: true, message: "反查 code 0 但沒有 invoice_number", raw: r.body };
      return { ok: true, found: true, invoiceNo: no, randomNumber: d.random_number ? String(d.random_number) : null, invoiceDate: /^\d{8}$/.test(String(d.invoice_date ?? "")) ? String(d.invoice_date) : taipeiYmd(), raw: r.body };
    },

    async void(input) {
      const r = await post("/json/f0501", [{ CancelInvoiceNumber: input.invoiceNo, CancelReason: input.reason.slice(0, 20) || "訂單取消" }]);
      if (!r.ok) return r;
      if (r.body.code !== AMEGO_OK) return fail(r.body, "作廢");
      return { ok: true, raw: r.body };
    },

    async allowance(input: AllowanceInput): Promise<ProviderResult<{ raw: Record<string, unknown> }>> {
      // 官方範例：折讓金額為「未稅」，稅額另列（AllowanceType 2 = 賣方折讓證明通知單）
      const untaxed = Math.round(input.amount / 1.05);
      const tax = input.amount - untaxed;
      const r = await post("/json/g0401", [
        {
          AllowanceNumber: input.allowanceNo,
          AllowanceDate: taipeiYmd(),
          AllowanceType: 2,
          BuyerIdentifier: input.buyerTaxId ?? "0000000000",
          BuyerName: input.buyerName.slice(0, 60) || "消費者",
          BuyerAddress: "",
          BuyerTelephoneNumber: "",
          BuyerEmailAddress: input.buyerEmail,
          ProductItem: [
            { OriginalInvoiceDate: Number(input.invoiceDate), OriginalInvoiceNumber: input.invoiceNo, OriginalDescription: input.description.slice(0, 256), Quantity: 1, UnitPrice: untaxed, Amount: untaxed, Tax: tax, TaxType: 1 },
          ],
          TaxAmount: tax,
          TotalAmount: untaxed,
        },
      ]);
      if (!r.ok) return r;
      if (r.body.code !== AMEGO_OK) return fail(r.body, "折讓");
      return { ok: true, raw: r.body };
    },
  };
}
