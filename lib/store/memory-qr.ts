import { randomUUID } from "node:crypto";
import type { BrandReportLinkRow, QrCodeRow, QrConversionRow, QrScanReportRow, QrScanRow, QrStore } from "./types-qr";

const clone = <T>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 記憶體實作（brandSales 由 memory-commerce 提供，因為要讀訂單） */
export function createMemoryQrStore(): Omit<QrStore, "brandSales"> {
  const codes = new Map<string, QrCodeRow>();
  const scans: QrScanRow[] = [];
  const conversions: QrConversionRow[] = [];
  const links = new Map<string, BrandReportLinkRow>();
  let scanSeq = 0;
  let convSeq = 0;
  return {
    async insertQrCode(row) {
      if ([...codes.values()].some((c) => c.tenant_id === row.tenant_id && (c.code === row.code || c.product_id === row.product_id))) return null;
      const r: QrCodeRow = { ...clone(row), id: randomUUID(), status: "active", created_at: now() };
      codes.set(r.id, r);
      return clone(r);
    },
    async getQrCodeByProduct(tenantId, productId) {
      return clone([...codes.values()].find((c) => c.tenant_id === tenantId && c.product_id === productId) ?? null);
    },
    async getQrCodeByCode(tenantId, code) {
      return clone([...codes.values()].find((c) => c.tenant_id === tenantId && c.code === code) ?? null);
    },
    async listQrCodes(tenantId, opts) {
      return clone([...codes.values()].filter((c) => c.tenant_id === tenantId && (!opts.codes || opts.codes.includes(c.code))));
    },
    async insertQrScan(row) {
      const r: QrScanRow = { ...clone(row), id: ++scanSeq, scanned_at: now() };
      scans.push(r);
      return clone(r);
    },
    async listQrScansByIds(tenantId, ids) {
      return clone(scans.filter((s) => s.tenant_id === tenantId && ids.includes(s.id)));
    },
    async insertQrConversion(row) {
      if (conversions.some((c) => c.kind === row.kind && c.ref_id === row.ref_id && c.product_id === row.product_id)) return false;
      conversions.push({ ...clone(row), id: ++convSeq, created_at: now() });
      return true;
    },
    async qrScanReport(tenantId, sinceIso, productIds) {
      const out = new Map<string, QrScanReportRow & { o: Set<string>; i: Set<string> }>();
      for (const s of scans) {
        if (s.tenant_id !== tenantId || s.scanned_at < sinceIso || (productIds?.length && !productIds.includes(s.product_id))) continue;
        const k = `${s.product_id}|${s.country ?? ""}|${s.lang}`;
        const row = out.get(k) ?? { product_id: s.product_id, country: s.country ?? "", lang: s.lang, scans: 0, orders: 0, inquiries: 0, o: new Set<string>(), i: new Set<string>() };
        row.scans++;
        for (const c of conversions) if (c.scan_id === s.id) (c.kind === "order" ? row.o : row.i).add(c.ref_id);
        out.set(k, row);
      }
      return [...out.values()].map(({ o, i, ...r }) => ({ ...r, orders: o.size, inquiries: i.size }));
    },
    async insertBrandReportLink(row) {
      const r: BrandReportLinkRow = { ...clone(row), id: randomUUID(), revoked_at: null, created_at: now() };
      links.set(r.id, r);
      return clone(r);
    },
    async getBrandReportLink(tenantId, id) {
      const l = links.get(id);
      return l && l.tenant_id === tenantId ? clone(l) : null;
    },
    async listBrandReportLinks(tenantId) {
      return clone([...links.values()].filter((l) => l.tenant_id === tenantId));
    },
    async revokeBrandReportLink(tenantId, id) {
      const l = links.get(id);
      if (!l || l.tenant_id !== tenantId || l.revoked_at) return false;
      links.set(id, { ...l, revoked_at: now() });
      return true;
    },
  };
}
