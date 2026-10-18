import { createHash } from "node:crypto";
import type { CertificateRow, Store, TenantRow } from "../store/types";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { maskName } from "./class-orders";

/* ================================================================== 正規化 */

/** 證號正規化：全形轉半形（NFKC）、大寫、去掉空白與分隔符號（- _ . / 等）。IFAR-D-2024-0142、ifar d 2024 0142 → IFARD20240142 */
export function normalizeCertNo(raw: unknown): string {
  return String(raw ?? "").normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** 姓名正規化：NFKC、去空白（含全形空白）、英文小寫 */
export function normalizeName(raw: unknown): string {
  return String(raw ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
/** 日期：YYYY-MM-DD、YYYY/MM/DD、YYYY.MM.DD（全形也可）→ YYYY-MM-DD；不合法回 null */
export function normalizeDate(raw: unknown): string | null {
  const s = String(raw ?? "").normalize("NFKC").trim();
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2200) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function requireCerts(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("certificates")) throw new ServiceError("forbidden", "此網站未啟用模組「certificates」，請先 enable_module certificates");
}

/* ================================================================== CSV 匯入 */

/** RFC 4180 CSV 解析（雙引號、跳脫的雙引號、CRLF；去掉 BOM） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === "") q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const HEADERS: Record<string, keyof ImportRow> = {
  證號: "certNo", 證書編號: "certNo", cert_no: "certNo", certno: "certNo",
  姓名: "name", name: "name",
  生日: "birth", 出生日期: "birth", birth_date: "birth", birth: "birth",
  類別: "category", 證照類別: "category", category: "category",
  發證日: "issued", 發證日期: "issued", issued_on: "issued", issued: "issued",
  到期日: "expires", 有效期限: "expires", expires_on: "expires", expires: "expires",
  狀態: "status", status: "status",
  備註: "note", note: "note",
};
interface ImportRow {
  certNo: string;
  name: string;
  birth: string;
  category: string;
  issued: string;
  expires: string;
  status: string;
  note: string;
}
const STATUS: Record<string, CertificateRow["status"]> = { valid: "valid", 有效: "valid", 正常: "valid", revoked: "revoked", 撤銷: "revoked", 註銷: "revoked", suspended: "suspended", 停權: "suspended", 暫停: "suspended" };

/** 🔴 CSV injection：= + - @ Tab CR（含全形 ＝＋－＠）開頭的儲存格一律拒絕（不存進 DB，日後匯出也就不會變公式） */
export const FORMULA_LIKE = /^[=+\-@\t\r＝＋－＠]/;

export const MAX_IMPORT_ROWS = 5000;

/**
 * 解析＋驗證匯入 CSV：第一列為標題（中英文欄名皆可，見 HEADERS），必填 證號／姓名／生日。
 * 每列錯誤附行號；任何一列有錯 → 整份不匯入（dryRun 也回同樣的報告）。
 */
export function validateCertificateCsv(tenantId: string, text: string): { rows: Omit<CertificateRow, "id" | "created_at" | "updated_at">[]; errors: string[] } {
  if (text.length > 2_000_000) return { rows: [], errors: ["檔案太大（上限約 2MB）"] };
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], errors: ["CSV 至少要有標題列與一列資料"] };
  const head = table[0]!.map((h) => HEADERS[h.trim().toLowerCase()] ?? HEADERS[h.trim()]);
  for (const need of ["certNo", "name", "birth"] as const) if (!head.includes(need)) return { rows: [], errors: [`缺少必要欄位：${need === "certNo" ? "證號" : need === "name" ? "姓名" : "生日"}`] };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { rows: [], errors: [`一次最多匯入 ${MAX_IMPORT_ROWS} 筆`] };
  const rows: Omit<CertificateRow, "id" | "created_at" | "updated_at">[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const r = { certNo: "", name: "", birth: "", category: "", issued: "", expires: "", status: "", note: "" } as ImportRow;
    head.forEach((k, j) => {
      if (k) r[k] = (cells[j] ?? "").trim();
    });
    const bad = Object.entries(r).find(([, v]) => FORMULA_LIKE.test(v));
    if (bad) {
      errors.push(`第 ${line} 列：欄位內容疑似公式（不可用 = + - @ 開頭）`);
      return;
    }
    const no = normalizeCertNo(r.certNo);
    if (no.length < 3 || no.length > 40) errors.push(`第 ${line} 列：證號格式不正確`);
    else if (seen.has(no)) errors.push(`第 ${line} 列：證號重複（${r.certNo}）`);
    const nameNorm = normalizeName(r.name);
    if (!nameNorm || r.name.length > 80) errors.push(`第 ${line} 列：姓名必填（80 字內）`);
    const birth = normalizeDate(r.birth);
    if (!birth) errors.push(`第 ${line} 列：生日格式需為 YYYY-MM-DD`);
    const issued = r.issued ? normalizeDate(r.issued) : null;
    if (r.issued && !issued) errors.push(`第 ${line} 列：發證日格式需為 YYYY-MM-DD`);
    const expires = r.expires ? normalizeDate(r.expires) : null;
    if (r.expires && !expires) errors.push(`第 ${line} 列：到期日格式需為 YYYY-MM-DD`);
    if (issued && expires && expires < issued) errors.push(`第 ${line} 列：到期日早於發證日`);
    const status = r.status ? STATUS[r.status.toLowerCase()] ?? STATUS[r.status] : "valid";
    if (!status) errors.push(`第 ${line} 列：狀態只能是 有效／撤銷／停權`);
    if (r.category.length > 80 || r.note.length > 300) errors.push(`第 ${line} 列：類別或備註太長`);
    seen.add(no);
    if (birth && status && nameNorm && no.length >= 3) {
      rows.push({ tenant_id: tenantId, cert_no: no, cert_no_display: r.certNo.normalize("NFKC").trim().slice(0, 60), name: r.name.normalize("NFKC").trim(), name_norm: nameNorm, birth_date: birth, category: r.category || null, issued_on: issued, expires_on: expires, status, note: r.note || null });
    }
  });
  return { rows: errors.length ? [] : rows, errors: errors.slice(0, 50) };
}

export async function importCertificates(ctx: ServiceContext, input: { site?: string | null; csv: string; dryRun?: boolean; confirm?: boolean }) {
  requireScope(ctx, "certificates:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCerts(ctx, tenant);
  const { rows, errors } = validateCertificateCsv(tenant.id, input.csv ?? "");
  if (errors.length) return { imported: false, errors, note: "有錯誤，整份未匯入。請修正後重新上傳。" };
  if (input.dryRun) return { imported: false, dryRun: true, rows: rows.length, errors: [], note: "驗證通過（dryRun，未寫入）。" };
  if (input.confirm !== true) throw new ServiceError("confirm_required", `匯入 ${rows.length} 筆證照（同證號會覆蓋）會立即可被公開查詢。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const r = await ctx.store.upsertCertificates(rows);
  await audit(ctx, tenant.id, "certificates.import", { rows: rows.length, ...r });
  return { imported: true, ...r, errors: [] };
}

/* ================================================================== 公開查詢 */

export const LOOKUP_NOT_FOUND = "查無符合的證照資料，請確認輸入內容是否正確。";
export const LOOKUP_RATE = { perIp: { limit: 10, window: 600 }, perKey: { limit: 10, window: 3600 } } as const;

const keyHash = (tenantId: string, k: string) => createHash("sha256").update(`${tenantId}:${k}`).digest("hex").slice(0, 32);

function todayTaipei() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 對外的證照資訊：🔴 不含生日、姓名遮罩；狀態依到期日計算 */
export function publicCertificate(c: CertificateRow) {
  const expired = !!c.expires_on && c.expires_on < todayTaipei();
  return {
    certNo: c.cert_no_display,
    name: maskName(c.name),
    category: c.category,
    issuedOn: c.issued_on,
    expiresOn: c.expires_on,
    status: c.status === "valid" ? (expired ? "expired" : "valid") : c.status,
    statusLabel: c.status === "revoked" ? "已撤銷" : c.status === "suspended" ? "停權中" : expired ? "已過期" : "有效",
  };
}

/**
 * 公開查詢（姓名＋生日，或證號）。安全規則（參考 IFAR /api/verify）：
 * - 兩種模式都要完整條件（只給姓名或只給生日 → 不查 DB，回查無）；
 * - 🔴 不回傳生日、姓名遮罩；查無與資料不符回**同一句話**（不洩漏證號或姓名是否存在）；
 * - 嚴格限流：每 IP 每 10 分鐘 10 次、每個查詢鍵（證號／姓名）每小時 10 次（builder_rate_hit 原子）；
 * - 每次查詢記一筆紀錄（只存 IP 與查詢鍵的雜湊、是否命中；只增不改）。
 */
export async function lookupCertificate(store: Store, tenant: TenantRow, input: { certNo?: unknown; name?: unknown; birth?: unknown; ipHash: string }) {
  if (!activeModuleIds(await moduleStates({ store }, tenant.id)).has("certificates")) throw new ServiceError("forbidden", "此網站未開放證照查詢");
  const ip = await store.rateHit(`cert-ip:${tenant.id}`, input.ipHash, LOOKUP_RATE.perIp.window, LOOKUP_RATE.perIp.limit);
  if (!ip.allowed) throw new ServiceError("rate_limited", "查詢太頻繁，請稍後再試");
  const certNo = normalizeCertNo(input.certNo);
  const nameNorm = normalizeName(input.name);
  const birth = normalizeDate(input.birth);
  let mode: "cert_no" | "name_birth";
  let key: string;
  if (certNo) {
    mode = "cert_no";
    key = `no:${certNo}`;
  } else {
    mode = "name_birth";
    key = `name:${nameNorm}`;
  }
  const kh = keyHash(tenant.id, key);
  const perKey = await store.rateHit(`cert-key:${tenant.id}`, kh, LOOKUP_RATE.perKey.window, LOOKUP_RATE.perKey.limit);
  if (!perKey.allowed) throw new ServiceError("rate_limited", "這筆資料查詢太頻繁，請稍後再試");
  let rows: CertificateRow[] = [];
  if (mode === "cert_no") {
    if (certNo.length >= 3 && certNo.length <= 40) {
      const c = await store.getCertificateByNo(tenant.id, certNo);
      rows = c ? [c] : [];
    }
  } else if (nameNorm && birth) {
    rows = await store.findCertificatesByNameBirth(tenant.id, nameNorm, birth);
  }
  await store.insertCertLookup({ tenant_id: tenant.id, mode, ip_hash: input.ipHash, found: rows.length > 0, key_hash: kh });
  if (!rows.length) return { found: false as const, message: LOOKUP_NOT_FOUND };
  return { found: true as const, results: rows.map(publicCertificate) };
}

/* ================================================================== 後台／MCP */

export async function listCertificates(ctx: ServiceContext, input: { site?: string | null; certNo?: string; limit?: number; offset?: number }) {
  requireScope(ctx, "certificates:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCerts(ctx, tenant);
  const r = await ctx.store.listCertificates(tenant.id, { limit: Math.max(1, Math.min(200, input.limit ?? 50)), offset: Math.max(0, input.offset ?? 0), q: input.certNo ? normalizeCertNo(input.certNo) : undefined });
  return { total: r.total, certificates: r.rows.map((c) => ({ id: c.id, ...publicCertificate(c), rawStatus: c.status, note: c.note })), note: "姓名遮罩、不含生日。" };
}

export async function setCertificateStatus(ctx: ServiceContext, input: { site?: string | null; certNo: string; status: "valid" | "revoked" | "suspended"; note?: string; confirm?: boolean }) {
  requireScope(ctx, "certificates:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCerts(ctx, tenant);
  if (!["valid", "revoked", "suspended"].includes(input.status)) throw new ServiceError("invalid", "status 只能是 valid／revoked／suspended");
  const c = await ctx.store.getCertificateByNo(tenant.id, normalizeCertNo(input.certNo));
  if (!c) throw new ServiceError("not_found", "找不到這張證照");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `把證照 ${c.cert_no_display} 改為「${input.status}」會立即反映在公開查詢。請先讓使用者確認，再以 confirm: true 呼叫。`);
  const row = (await ctx.store.updateCertificate(tenant.id, c.id, { status: input.status, note: input.note?.slice(0, 300) ?? c.note }))!;
  await audit(ctx, tenant.id, "certificates.status", { certNo: c.cert_no, status: input.status });
  return publicCertificate(row);
}

export async function listCertificateLookups(ctx: ServiceContext, input: { site?: string | null; limit?: number }) {
  requireScope(ctx, "certificates:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireCerts(ctx, tenant);
  const rows = await ctx.store.listCertLookups(tenant.id, Math.max(1, Math.min(500, input.limit ?? 100)));
  return { lookups: rows.map((r) => ({ at: r.at, mode: r.mode, found: r.found })) };
}
