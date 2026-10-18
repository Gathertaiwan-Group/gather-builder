import type { InvoiceProviderId, InvoiceRequest } from "../store/types";

/**
 * 電子發票供應商介面（第一家 Amego；日後加綠界、藍新等只要實作這個介面）。
 *
 * 🔴 結果分三種，不是布林：
 *   ok                     成功
 *   ok:false, retryable    暫時失敗（連線、逾時、中繼／WAF 回非供應商格式、IP 白名單）→ 稍後重試
 *   ok:false, !retryable   資料錯（統編錯、欄位錯）→ 重試一萬次也一樣，要人改
 * 「無法確認」（例如查詢失敗）絕不能被讀成「沒開過」。
 */
export type ProviderFail = { ok: false; retryable: boolean; message: string; code?: string | number; raw?: unknown };
export type ProviderResult<T> = ({ ok: true } & T) | ProviderFail;

export interface IssueInput {
  /** 對外訂單編號：Amego OrderId（唯一），也是反查認回的唯一依據 */
  orderNo: string;
  total: number;
  items: { name: string; qty: number; unitPrice: number }[];
  buyerEmail: string;
  buyerName: string;
  request: InvoiceRequest;
}

export interface IssuedInvoice {
  invoiceNo: string;
  randomNumber: string | null;
  /** YYYYMMDD（台北） */
  invoiceDate: string;
  raw: Record<string, unknown>;
}

export interface AllowanceInput {
  allowanceNo: string;
  invoiceNo: string;
  invoiceDate: string;
  /** 含稅金額 */
  amount: number;
  buyerEmail: string;
  buyerName: string;
  buyerTaxId: string | null;
  description: string;
}

export interface InvoiceProvider {
  id: InvoiceProviderId;
  /** 驗證憑證（不開票） */
  verify(): Promise<ProviderResult<object>>;
  issue(input: IssueInput): Promise<ProviderResult<IssuedInvoice> & { duplicate?: boolean }>;
  /** 依訂單編號反查：found:false 只代表「確定沒開過」 */
  query(orderNo: string): Promise<ProviderResult<{ found: false } | ({ found: true } & IssuedInvoice)>>;
  void(input: { invoiceNo: string; reason: string }): Promise<ProviderResult<{ raw: Record<string, unknown> }>>;
  allowance(input: AllowanceInput): Promise<ProviderResult<{ raw: Record<string, unknown> }>>;
}

/** 台北日期 YYYYMMDD */
export function taipeiYmd(d = new Date()): string {
  const tw = new Date(d.getTime() + 8 * 3600_000);
  return `${tw.getUTCFullYear()}${String(tw.getUTCMonth() + 1).padStart(2, "0")}${String(tw.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 能不能作廢：只有「同一期（雙月）」內開立的發票可以直接作廢；跨期一律改開折讓。
 * 這是保守規則（不採用次期申報期限前的寬限），避免作廢已申報的發票。
 */
export function canVoidInPeriod(invoiceDate: string, now = new Date()): boolean {
  const period = (ymd: string) => Number(ymd.slice(0, 4)) * 6 + Math.floor((Number(ymd.slice(4, 6)) - 1) / 2);
  if (!/^\d{8}$/.test(invoiceDate)) return false;
  return period(invoiceDate) === period(taipeiYmd(now));
}

/**
 * 發票明細：商品＋運費＋折扣（負數），加總一定等於實收金額；差額補一列尾差。
 */
export function invoiceLines(order: { items: { name: string; variant_label: string | null; qty: number; unit_price: number }[]; shipping_fee: number; discount_total?: number; total: number }) {
  const lines = order.items.map((i) => ({ name: `${i.name}${i.variant_label ? `（${i.variant_label}）` : ""}`.slice(0, 200), qty: i.qty, unitPrice: i.unit_price }));
  if (order.shipping_fee > 0) lines.push({ name: "運費", qty: 1, unitPrice: order.shipping_fee });
  if (order.discount_total && order.discount_total > 0) lines.push({ name: "折扣", qty: 1, unitPrice: -order.discount_total });
  const sum = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  if (sum !== order.total) lines.push({ name: "尾差調整", qty: 1, unitPrice: order.total - sum });
  return lines;
}
