/**
 * downloads（文件下載，記憶體 Store＋記憶體 Storage）：檔名淨化與副檔名白名單、簽名上傳流程、限會員 server 檢查、
 * 簽名網址 60 秒過期、下載計次、草稿／上傳中不可下載、公開文件才進搜尋、表單直傳 4MB 上限、上架 confirm。
 * 真 Storage（builder-downloads）在 tests/integration/content.test.ts。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { publishSite } from "@/lib/services/publish";
import { DOWNLOAD_URL_SECONDS, completeDocumentUpload, createDocumentUpload, downloadDocument, listDocuments, sanitizeFileName, updateDocument, uploadDocumentDirect } from "@/lib/services/downloads";
import { memoryFileStorage } from "@/lib/storage/files";
import { searchSite } from "@/lib/services/search";
import { loadSite } from "@/lib/site-loader";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

describe("檔名淨化", () => {
  it("去掉路徑與控制字元、保留中文、副檔名白名單（html／svg／exe 拒絕）", () => {
    expect(sanitizeFileName("../../etc/年度報告\u0000 2026.PDF")).toMatchObject({ display: "年度報告 2026.pdf", ext: "pdf", contentType: "application/pdf" });
    expect(sanitizeFileName("C:\\\\x\\\\a:b*c?.docx").display).toBe("a_b_c_.docx");
    expect(sanitizeFileName("報名表.xlsx").key).toBe("file.xlsx");
    expect(sanitizeFileName("Form A.pdf").key).toBe("form-a.pdf");
    for (const bad of ["x.html", "x.svg", "x.exe", "noext", ".htaccess", "a.js"]) expect(() => sanitizeFileName(bad)).toThrow(/不支援/);
  });
});

describe("上傳與下載", () => {
  async function setup() {
    const store = newStore();
    const storage = memoryFileStorage();
    const ctx = ctxFor(store);
    await createSite(ctx, { slug: "assoc-dl", name: "協會", modules: ["sections-basic", "downloads", "members", "search"] });
    await publishSite(ctx, { site: "assoc-dl", confirm: true });
    const tenant = (await store.getTenantBySlug("assoc-dl"))!;
    return { store, storage, ctx, tenant };
  }

  it("簽名上傳 → 確認檔案存在才可上架；限會員文件：未登入被拒、會員可下載；簽名網址 60 秒後失效；下載計次", async () => {
    const { store, storage, ctx, tenant } = await setup();
    const up = await createDocumentUpload(ctx, { site: "assoc-dl", fileName: "會員手冊.pdf", title: "會員手冊", visibility: "members" }, storage);
    expect(up).toMatchObject({ method: "PUT", contentType: "application/pdf" });
    await expect(completeDocumentUpload(ctx, { site: "assoc-dl", documentId: up.documentId }, storage)).rejects.toThrow(/還沒有收到檔案/);
    // 上傳中不可下載
    await expect(downloadDocument(store, storage, { tenant, documentId: up.documentId, member: null })).rejects.toMatchObject({ code: "not_found" });
    storage.putSigned(up.uploadUrl.split("/").pop()!, new TextEncoder().encode("%PDF-1.4 test"), "application/pdf");
    await expect(completeDocumentUpload(ctx, { site: "assoc-dl", documentId: up.documentId, publish: true }, storage)).rejects.toMatchObject({ code: "confirm_required" });
    const done = await completeDocumentUpload(ctx, { site: "assoc-dl", documentId: up.documentId, publish: true, confirm: true }, storage);
    expect(done).toMatchObject({ status: "published", sizeBytes: 13 });
    await expect(downloadDocument(store, storage, { tenant, documentId: up.documentId, member: null })).rejects.toMatchObject({ code: "unauthorized" });
    const m = (await store.insertMember({ tenant_id: tenant.id, email: "m@example.com", password_hash: "x", name: "會員", phone: null }))!;
    const r = await downloadDocument(store, storage, { tenant, documentId: up.documentId, member: m });
    expect(storage.fetchSigned(r.url).status).toBe(200);
    expect(storage.fetchSigned(r.url, Date.now() + (DOWNLOAD_URL_SECONDS + 1) * 1000).status).toBe(400);
    // 停用的會員不能下載
    await expect(downloadDocument(store, storage, { tenant, documentId: up.documentId, member: { ...m, status: "disabled" } })).rejects.toMatchObject({ code: "unauthorized" });
    expect((await listDocuments(ctx, { site: "assoc-dl" })).documents[0]!.downloads).toBe(1);
    // 限會員的文件不進搜尋
    const site = (await loadSite("assoc-dl", null, store, { lang: null }))!;
    expect((await searchSite(store, site, "會員手冊")).results).toEqual([]);
  });

  it("表單直傳：4MB 上限；公開文件也走簽名網址；公開文件搜得到；下架後不可下載", async () => {
    const { store, storage, ctx, tenant } = await setup();
    await expect(uploadDocumentDirect(ctx, { site: "assoc-dl", fileName: "big.zip", bytes: new Uint8Array(4 * 1024 * 1024 + 1), title: "大檔" }, storage)).rejects.toThrow(/4MB/);
    const d = await uploadDocumentDirect(ctx, { site: "assoc-dl", fileName: "入會申請表.docx", bytes: new Uint8Array([1, 2, 3]), title: "入會申請表", publish: true, confirm: true }, storage);
    const r = await downloadDocument(store, storage, { tenant, documentId: d.id, member: null });
    expect(r.url).toMatch(/^memory:\/\/download\//);
    const site = (await loadSite("assoc-dl", null, store, { lang: null }))!;
    expect((await searchSite(store, site, "入會申請")).results.map((x) => x.kind)).toEqual(["document"]);
    await updateDocument(ctx, { site: "assoc-dl", documentId: d.id, patch: { status: "draft" }, confirm: true });
    await expect(downloadDocument(store, storage, { tenant, documentId: d.id, member: null })).rejects.toMatchObject({ code: "not_found" });
    // 物件路徑一定在租戶資料夾
    expect([...storage.files.keys()][0]!.startsWith(`${tenant.id}/`)).toBe(true);
  });
});
