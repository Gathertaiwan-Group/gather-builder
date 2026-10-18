/**
 * certificates（證照查詢，記憶體 Store）：CSV 匯入驗證與 injection、證號容錯、不回生日、姓名遮罩、
 * 查無與不符同一句話、只給一半條件不查、限流（每 IP、每查詢鍵）、查詢紀錄、狀態與到期、scope／confirm。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { publishSite } from "@/lib/services/publish";
import { LOOKUP_NOT_FOUND, importCertificates, listCertificateLookups, lookupCertificate, normalizeCertNo, parseCsv, setCertificateStatus, validateCertificateCsv } from "@/lib/services/certificates";
import type { Actor } from "@/lib/tokens";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

const CSV = "﻿證號,姓名,生日,類別,發證日,到期日,狀態\r\nIFAR-D-2024-0142,王雅琳,1988-03-12,花藝設計師,2024/05/01,2027-05-01,有效\r\n\"IFAR-D-2020-0001\",陳 小明,1975-1-2,講師,2020-01-01,2021-01-01,有效\r\nIFAR-X-2023-0009,林美,1990-07-07,,,,撤銷\r\n";

async function site(store: Store, slug = "ifar-like") {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: "花藝協會", modules: ["sections-basic", "certificates"] });
  await publishSite(ctx, { site: slug, confirm: true });
  await importCertificates(ctx, { site: slug, csv: CSV, confirm: true });
  return { ctx, tenant: (await store.getTenantBySlug(slug))! };
}

describe("CSV 匯入", () => {
  it("解析引號／CRLF／BOM；欄位以 = + - @（含全形）開頭整份拒絕；格式錯誤附行號；dryRun 不寫入；要 confirm", async () => {
    expect(parseCsv('a,"b,""c""",d\r\n1,2,3')).toEqual([["a", 'b,"c"', "d"], ["1", "2", "3"]]);
    for (const evil of ["=HYPERLINK(\"x\")", "+1+1", "-2+3", "@SUM(A1)", "＝1+1"]) {
      const r = validateCertificateCsv("t", `證號,姓名,生日\nA001,${evil},1990-01-01\n`);
      expect(r.rows).toEqual([]);
      expect(r.errors[0]).toMatch(/第 2 列：欄位內容疑似公式/);
    }
    const bad = validateCertificateCsv("t", "證號,姓名,生日\nA001,王,1990-02-30\nA001,李,1990-01-01\n,張,1990-01-01\n");
    expect(bad.errors).toEqual(expect.arrayContaining(["第 2 列：生日格式需為 YYYY-MM-DD", "第 3 列：證號重複（A001）", "第 4 列：證號格式不正確"]));
    expect(validateCertificateCsv("t", "姓名,生日\n王,1990-01-01\n").errors[0]).toMatch(/缺少必要欄位：證號/);
    const store = newStore();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "csv-site", name: "x", modules: ["certificates"] });
    expect(await importCertificates(ctx, { site: "csv-site", csv: CSV, dryRun: true })).toMatchObject({ dryRun: true, rows: 3 });
    await expect(importCertificates(ctx, { site: "csv-site", csv: CSV })).rejects.toMatchObject({ code: "confirm_required" });
    expect(await importCertificates(ctx, { site: "csv-site", csv: CSV, confirm: true })).toMatchObject({ imported: true, inserted: 3, updated: 0 });
    expect(await importCertificates(ctx, { site: "csv-site", csv: CSV, confirm: true })).toMatchObject({ inserted: 0, updated: 3 });
    const ro: Actor = { kind: "token", tokenId: "t", tenantId: (await store.getTenantBySlug("csv-site"))!.id, scopes: ["site:read", "certificates:read"], label: "ro" };
    await expect(importCertificates(ctxFor(store, ro), { csv: CSV, confirm: true })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("公開查詢", () => {
  it("證號容錯（全形、小寫、空白、無分隔）；不回傳生日、姓名遮罩；過期與撤銷狀態", async () => {
    const store = newStore();
    const { tenant } = await site(store);
    expect(normalizeCertNo(" ｉｆａｒ－ｄ－２０２４－０１４２ ")).toBe("IFARD20240142");
    for (const q of ["IFAR-D-2024-0142", "ifar d 2024 0142", "IFARD20240142", "ＩＦＡＲ－Ｄ－２０２４－０１４２"]) {
      const r = await lookupCertificate(store, tenant, { certNo: q, ipHash: `ip-${q}` });
      expect(r).toMatchObject({ found: true, results: [{ certNo: "IFAR-D-2024-0142", name: "王＊琳", category: "花藝設計師", status: "valid" }] });
      expect(JSON.stringify(r)).not.toContain("1988");
    }
    const exp = await lookupCertificate(store, tenant, { name: "陳小明", birth: "1975-01-02", ipHash: "ip-x" });
    expect(exp).toMatchObject({ found: true, results: [{ status: "expired", statusLabel: "已過期" }] });
    const rev = await lookupCertificate(store, tenant, { certNo: "IFAR-X-2023-0009", ipHash: "ip-y" });
    expect(rev).toMatchObject({ results: [{ status: "revoked" }] });
  });

  it("查無、姓名對生日錯、只給姓名、只給生日 → 一律同一句話（不洩漏是否存在）；查詢紀錄只記是否查到", async () => {
    const store = newStore();
    const { ctx, tenant } = await site(store);
    const cases = [
      { certNo: "NOPE-0000" },
      { name: "王雅琳", birth: "1988-03-13" },
      { name: "王雅琳" },
      { birth: "1988-03-12" },
      { name: "不存在的人", birth: "1988-03-12" },
    ];
    for (const [i, c] of cases.entries()) {
      const r = await lookupCertificate(store, tenant, { ...c, ipHash: `ip-miss-${i}` });
      expect(r).toEqual({ found: false, message: LOOKUP_NOT_FOUND });
    }
    expect((await listCertificateLookups(ctx, { site: "ifar-like" })).lookups.every((l) => l.found === false)).toBe(true);
    expect(JSON.stringify(await listCertificateLookups(ctx, { site: "ifar-like" }))).not.toContain("王");
  });

  it("限流：同一 IP 10 分鐘 10 次；同一證號（換 IP）每小時 10 次", async () => {
    const store = newStore();
    const { tenant } = await site(store);
    for (let i = 0; i < 10; i++) await lookupCertificate(store, tenant, { certNo: `MISS${i}000`, ipHash: "same-ip" });
    await expect(lookupCertificate(store, tenant, { certNo: "IFARD20240142", ipHash: "same-ip" })).rejects.toMatchObject({ code: "rate_limited" });
    for (let i = 0; i < 10; i++) await lookupCertificate(store, tenant, { certNo: "IFAR-D-2024-0142", ipHash: `rot-${i}` });
    await expect(lookupCertificate(store, tenant, { certNo: "ifar d 2024 0142", ipHash: "rot-new" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("set_certificate_status 要 confirm，立即反映；別的網站查不到", async () => {
    const store = newStore();
    const { ctx, tenant } = await site(store);
    await expect(setCertificateStatus(ctx, { site: "ifar-like", certNo: "ifard20240142", status: "suspended" })).rejects.toMatchObject({ code: "confirm_required" });
    await setCertificateStatus(ctx, { site: "ifar-like", certNo: "ifard20240142", status: "suspended", confirm: true });
    expect(await lookupCertificate(store, tenant, { certNo: "IFAR-D-2024-0142", ipHash: "a" })).toMatchObject({ results: [{ status: "suspended" }] });
    const other = await site(store, "other-assoc");
    await store.upsertCertificates([]);
    expect((await lookupCertificate(store, other.tenant, { certNo: "IFARD20240142", ipHash: "b" })).found).toBe(true); // 同 CSV 匯入到別站：各站獨立
    const empty = ctxFor(store);
    await createSite(empty, { slug: "no-certs", name: "y", modules: ["certificates"] });
    await publishSite(empty, { site: "no-certs", confirm: true }).catch(() => undefined);
    expect(await lookupCertificate(store, (await store.getTenantBySlug("no-certs"))!, { certNo: "IFARD20240142", ipHash: "c" })).toEqual({ found: false, message: LOOKUP_NOT_FOUND });
  });
});
