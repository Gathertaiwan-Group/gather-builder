import type { SupabaseClient } from "@supabase/supabase-js";
import { ServiceError } from "../errors";
import type { BrandReportLinkRow, BrandSalesRow, QrCodeRow, QrScanReportRow, QrScanRow, QrStore } from "./types-qr";

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
function must<T>(r: Res<T>, what: string): T {
  if (r.error) {
    if (r.error.code === "23505") throw new ServiceError("conflict", "資料重複");
    throw new Error(`${what}: ${r.error.message}`);
  }
  return r.data as T;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID.test(s);
const num = (v: unknown) => Number(v ?? 0);

export function createSupabaseQrStore(db: SupabaseClient): QrStore {
  return {
    async insertQrCode(row) {
      const r = await db.from("builder_qr_codes").insert(row).select("*").single();
      if (r.error?.code === "23505") return null;
      return must(r, "insertQrCode") as QrCodeRow;
    },
    async getQrCodeByProduct(tenantId, productId) {
      if (!isUuid(productId)) return null;
      return must(await db.from("builder_qr_codes").select("*").eq("tenant_id", tenantId).eq("product_id", productId).maybeSingle(), "getQrCodeByProduct") as QrCodeRow | null;
    },
    async getQrCodeByCode(tenantId, code) {
      if (!/^[A-Za-z0-9]{10}$/.test(code)) return null;
      return must(await db.from("builder_qr_codes").select("*").eq("tenant_id", tenantId).eq("code", code).maybeSingle(), "getQrCodeByCode") as QrCodeRow | null;
    },
    async listQrCodes(tenantId, opts) {
      let q = db.from("builder_qr_codes").select("*").eq("tenant_id", tenantId);
      if (opts.codes) {
        const codes = opts.codes.filter((c) => /^[A-Za-z0-9]{10}$/.test(c));
        if (!codes.length) return [];
        q = q.in("code", codes);
      }
      return (must(await q.order("created_at").limit(1000), "listQrCodes") ?? []) as QrCodeRow[];
    },
    async insertQrScan(row) {
      return must(await db.from("builder_qr_scans").insert(row).select("*").single(), "insertQrScan") as QrScanRow;
    },
    async listQrScansByIds(tenantId, ids) {
      const valid = ids.filter((n) => Number.isSafeInteger(n) && n > 0);
      if (!valid.length) return [];
      return (must(await db.from("builder_qr_scans").select("*").eq("tenant_id", tenantId).in("id", valid), "listQrScansByIds") ?? []) as QrScanRow[];
    },
    async insertQrConversion(row) {
      const r = await db.from("builder_qr_conversions").insert(row);
      if (r.error?.code === "23505") return false;
      must(r, "insertQrConversion");
      return true;
    },
    async qrScanReport(tenantId, sinceIso, productIds) {
      const rows = (must(await db.rpc("builder_qr_scan_report", { p_tenant: tenantId, p_since: sinceIso, p_products: productIds?.length ? productIds.filter(isUuid) : null }), "qrScanReport") ?? []) as Record<string, unknown>[];
      return rows.map((r) => ({ product_id: String(r.product_id), country: String(r.country ?? ""), lang: String(r.lang), scans: num(r.scans), orders: num(r.orders), inquiries: num(r.inquiries) })) as QrScanReportRow[];
    },
    async brandSales(tenantId, productIds, sinceIso) {
      const ids = productIds.filter(isUuid);
      if (!ids.length) return [];
      const rows = (must(await db.rpc("builder_brand_sales", { p_tenant: tenantId, p_products: ids, p_since: sinceIso }), "brandSales") ?? []) as Record<string, unknown>[];
      return rows.map((r) => ({ product_id: String(r.product_id), qty: num(r.qty), revenue: num(r.revenue), orders: num(r.orders) })) as BrandSalesRow[];
    },
    async insertBrandReportLink(row) {
      return must(await db.from("builder_brand_report_links").insert(row).select("*").single(), "insertBrandReportLink") as BrandReportLinkRow;
    },
    async getBrandReportLink(tenantId, id) {
      if (!isUuid(id)) return null;
      return must(await db.from("builder_brand_report_links").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle(), "getBrandReportLink") as BrandReportLinkRow | null;
    },
    async listBrandReportLinks(tenantId) {
      return (must(await db.from("builder_brand_report_links").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(200), "listBrandReportLinks") ?? []) as BrandReportLinkRow[];
    },
    async revokeBrandReportLink(tenantId, id) {
      if (!isUuid(id)) return false;
      const rows = must(await db.from("builder_brand_report_links").update({ revoked_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", id).is("revoked_at", null).select("id"), "revokeBrandReportLink") as { id: string }[];
      return rows.length > 0;
    },
  };
}
