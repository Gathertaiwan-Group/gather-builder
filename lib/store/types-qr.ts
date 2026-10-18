/* ------------------------------------------------------------------ qr-catalog（實體門市 QR 多語商品頁，第八批） */

export interface QrCodeRow {
  id: string;
  tenant_id: string;
  product_id: string;
  /** 10 字隨機英數（不可預測） */
  code: string;
  status: "active" | "disabled";
  created_at: string;
}

/** 🔴 不存 IP、不存 UA：只有時間、商品、語言、國家碼（Vercel geo header；可缺） */
export interface QrScanRow {
  id: number;
  tenant_id: string;
  qr_id: string;
  product_id: string;
  lang: string;
  country: string | null;
  scanned_at: string;
}

export interface QrConversionRow {
  id: number;
  tenant_id: string;
  scan_id: number;
  product_id: string;
  kind: "order" | "inquiry";
  ref_id: string;
  created_at: string;
}

export interface BrandReportLinkRow {
  id: string;
  tenant_id: string;
  brand: string;
  label: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

export interface QrScanReportRow {
  product_id: string;
  /** 空字串＝沒有國家碼 */
  country: string;
  lang: string;
  scans: number;
  orders: number;
  inquiries: number;
}

export interface BrandSalesRow {
  product_id: string;
  qty: number;
  revenue: number;
  orders: number;
}

export interface QrStore {
  /** (tenant, code) 或 (tenant, product) 重複回 null */
  insertQrCode(row: Pick<QrCodeRow, "tenant_id" | "product_id" | "code">): Promise<QrCodeRow | null>;
  getQrCodeByProduct(tenantId: string, productId: string): Promise<QrCodeRow | null>;
  getQrCodeByCode(tenantId: string, code: string): Promise<QrCodeRow | null>;
  listQrCodes(tenantId: string, opts: { codes?: string[] }): Promise<QrCodeRow[]>;
  /** 只增不改 */
  insertQrScan(row: Omit<QrScanRow, "id" | "scanned_at">): Promise<QrScanRow>;
  listQrScansByIds(tenantId: string, ids: number[]): Promise<QrScanRow[]>;
  /** 只增不改：unique(kind, ref_id, product_id)，已存在回 false */
  insertQrConversion(row: Omit<QrConversionRow, "id" | "created_at">): Promise<boolean>;
  qrScanReport(tenantId: string, sinceIso: string, productIds?: string[] | null): Promise<QrScanReportRow[]>;
  /** 已付款／已出貨、非 sandbox、未退款的銷售（只回數量與金額） */
  brandSales(tenantId: string, productIds: string[], sinceIso: string): Promise<BrandSalesRow[]>;
  insertBrandReportLink(row: Pick<BrandReportLinkRow, "tenant_id" | "brand" | "label" | "expires_at" | "created_by">): Promise<BrandReportLinkRow>;
  getBrandReportLink(tenantId: string, id: string): Promise<BrandReportLinkRow | null>;
  listBrandReportLinks(tenantId: string): Promise<BrandReportLinkRow[]>;
  /** revoked_at 由 null 改成 now 的那一次回 true */
  revokeBrandReportLink(tenantId: string, id: string): Promise<boolean>;
}
