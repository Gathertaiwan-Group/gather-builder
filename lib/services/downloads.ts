import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DocumentRow, MemberRow, Store, TenantRow } from "../store/types";
import { optText, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import type { FileStorage } from "../storage/files";

/* ================================================================== 規則 */

/** 單檔上限（bucket file_size_limit 也是 50MB）；後台表單直傳上限 4MB（Vercel body 4.5MB），更大的走簽名上傳網址 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DIRECT_UPLOAD_MAX = 4 * 1024 * 1024;
/** 下載簽名網址有效秒數（點了才產生，短效） */
export const DOWNLOAD_URL_SECONDS = 60;

/** 允許的副檔名 → Content-Type（不接受 html／svg／js／exe 這類可執行或可注入腳本的檔案） */
export const ALLOWED_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  txt: "text/plain",
  zip: "application/zip",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

/**
 * 檔名淨化：去掉路徑分隔、控制字元、Windows 保留字元、開頭的點；保留中文；最長 120 字（保留副檔名）。
 * 副檔名必須在白名單。回傳顯示用檔名＋儲存用 key（ASCII）＋ Content-Type。
 */
export function sanitizeFileName(raw: string): { display: string; key: string; ext: string; contentType: string } {
  let n = (raw ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "");
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[:*?"<>|]/g, "_").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim();
  const dot = n.lastIndexOf(".");
  const ext = dot > 0 ? n.slice(dot + 1).toLowerCase() : "";
  if (!ext || !ALLOWED_TYPES[ext]) throw new ServiceError("invalid", `不支援這種檔案類型（可上傳：${Object.keys(ALLOWED_TYPES).join("、")}）`);
  let base = n.slice(0, dot).slice(0, 110) || "file";
  const display = `${base}.${ext}`;
  base = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
  return { display, key: `${base}.${ext}`, ext, contentType: ALLOWED_TYPES[ext]! };
}

async function requireDownloads(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("downloads")) throw new ServiceError("forbidden", "此網站未啟用模組「downloads」，請先 enable_module downloads");
}
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請維持 draft。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

const meta = z
  .object({
    title: text(160),
    category: optText(40),
    description: optText(1000),
    visibility: z.enum(["public", "members"]).default("public"),
    sort: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

export function documentSummary(d: DocumentRow) {
  return { id: d.id, title: d.title, category: d.category, description: d.description, fileName: d.file_name, sizeBytes: d.size_bytes, contentType: d.content_type, visibility: d.visibility, status: d.status, downloads: d.download_count, sort: d.sort };
}

/* ================================================================== 上傳 */

/**
 * 建立文件＋簽名上傳網址（大檔直傳 Supabase Storage，不經 Vercel）。上傳完成後呼叫 completeDocumentUpload 確認檔案存在才可公開。
 * MCP／agent：拿到 uploadUrl 後 `curl -X PUT --data-binary @檔案 -H "Content-Type: <contentType>" "<uploadUrl>"`。
 */
export async function createDocumentUpload(ctx: ServiceContext, input: { site?: string | null; fileName: string; sizeBytes?: number } & z.input<typeof meta>, storage: FileStorage) {
  requireScope(ctx, "content:write");
  const { site, fileName, sizeBytes, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireDownloads(ctx, tenant);
  const m = parse(meta, rest);
  const f = sanitizeFileName(fileName);
  if (sizeBytes !== undefined && (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES)) throw new ServiceError("invalid", `檔案大小上限 ${MAX_FILE_BYTES / 1024 / 1024}MB`);
  const id = randomUUID();
  const path = `${tenant.id}/${id}/${f.key}`;
  const up = await storage.signedUploadUrl(path);
  await ctx.store.insertDocument({ id, tenant_id: tenant.id, title: m.title, category: m.category ?? null, description: m.description ?? null, file_path: path, file_name: f.display, content_type: f.contentType, size_bytes: null, visibility: m.visibility, status: "uploading", sort: m.sort });
  await audit(ctx, tenant.id, "downloads.upload_start", { documentId: id, fileName: f.display });
  return { documentId: id, uploadUrl: up.url, method: "PUT", contentType: f.contentType, maxBytes: MAX_FILE_BYTES, note: "請把檔案以 PUT 上傳到 uploadUrl（Content-Type 用上面的值），完成後呼叫 complete_document_upload。上傳網址約 2 小時內有效。" };
}

/** 確認簽名上傳已完成（檔案存在、大小未超過）→ 草稿或上架（上架需 publish＋confirm） */
export async function completeDocumentUpload(ctx: ServiceContext, input: { site?: string | null; documentId: string; publish?: boolean; confirm?: boolean }, storage: FileStorage) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireDownloads(ctx, tenant);
  const d = await ctx.store.getDocument(tenant.id, input.documentId);
  if (!d || !d.file_path) throw new ServiceError("not_found", "找不到文件");
  if (input.publish) requireLiveConfirm(ctx, "上架文件", input.confirm);
  const st = await storage.stat(d.file_path);
  if (!st) throw new ServiceError("invalid", "還沒有收到檔案，請先把檔案 PUT 到上傳網址");
  if (st.size > MAX_FILE_BYTES) throw new ServiceError("invalid", "檔案超過大小上限");
  const row = (await ctx.store.updateDocument(tenant.id, d.id, { size_bytes: st.size, status: input.publish ? "published" : d.status === "uploading" ? "draft" : d.status }))!;
  await audit(ctx, tenant.id, "downloads.upload_complete", { documentId: d.id, size: st.size, status: row.status });
  return documentSummary(row);
}

/** 後台表單直傳（≤ 4MB；更大請用簽名上傳網址） */
export async function uploadDocumentDirect(ctx: ServiceContext, input: { site?: string | null; fileName: string; bytes: Uint8Array; publish?: boolean; confirm?: boolean } & z.input<typeof meta>, storage: FileStorage) {
  requireScope(ctx, "content:write");
  const { site, fileName, bytes, publish, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireDownloads(ctx, tenant);
  const m = parse(meta, rest);
  const f = sanitizeFileName(fileName);
  if (!bytes.length) throw new ServiceError("invalid", "檔案是空的");
  if (bytes.length > DIRECT_UPLOAD_MAX) throw new ServiceError("invalid", `表單上傳上限 4MB；更大的檔案請用簽名上傳網址（create_document_upload）`);
  if (publish) requireLiveConfirm(ctx, "上架文件", confirm);
  const id = randomUUID();
  const path = `${tenant.id}/${id}/${f.key}`;
  await storage.upload(path, bytes, f.contentType);
  const row = await ctx.store.insertDocument({ id, tenant_id: tenant.id, title: m.title, category: m.category ?? null, description: m.description ?? null, file_path: path, file_name: f.display, content_type: f.contentType, size_bytes: bytes.length, visibility: m.visibility, status: publish ? "published" : "draft", sort: m.sort });
  await audit(ctx, tenant.id, "downloads.upload", { documentId: id, size: bytes.length, status: row.status });
  return documentSummary(row);
}

export async function updateDocument(ctx: ServiceContext, input: { site?: string | null; documentId: string; patch: Partial<z.input<typeof meta>> & { status?: "draft" | "published" }; confirm?: boolean }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireDownloads(ctx, tenant);
  const d = await ctx.store.getDocument(tenant.id, input.documentId);
  if (!d) throw new ServiceError("not_found", "找不到文件");
  const { status, ...given } = input.patch ?? {};
  const p = parse(meta.partial().strict(), given);
  if (status !== undefined && !["draft", "published"].includes(status)) throw new ServiceError("invalid", "status 只能是 draft 或 published");
  if (status === "published" && (d.status === "uploading" || !d.size_bytes)) throw new ServiceError("invalid", "檔案還沒上傳完成，不能上架");
  if (d.status === "published" || status === "published") requireLiveConfirm(ctx, "修改／上架／下架已公開的文件", input.confirm);
  const patch: Partial<DocumentRow> = {};
  if (given.title !== undefined) patch.title = p.title;
  if (given.category !== undefined) patch.category = p.category ?? null;
  if (given.description !== undefined) patch.description = p.description ?? null;
  if (given.visibility !== undefined) patch.visibility = p.visibility;
  if (given.sort !== undefined) patch.sort = p.sort;
  if (status !== undefined) patch.status = status;
  const row = (await ctx.store.updateDocument(tenant.id, d.id, patch))!;
  await audit(ctx, tenant.id, "downloads.update", { documentId: d.id, keys: Object.keys(input.patch ?? {}) });
  return documentSummary(row);
}

export async function listDocuments(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireDownloads(ctx, tenant);
  const rows = await ctx.store.listDocuments(tenant.id, {});
  return { total: rows.length, documents: rows.map(documentSummary) };
}

/* ================================================================== 前台下載 */

export async function publicDocuments(store: Store, tenant: TenantRow) {
  return store.listDocuments(tenant.id, { status: "published" });
}

/**
 * 下載（前台 GET /s/<slug>/downloads/<id>）：必須已上架；限會員的文件 🔴 在 server 端檢查會員 session（cookie 屬於這個網站、會員未停用）。
 * 通過才計次（原子 +1）並產生 60 秒簽名網址（公開文件也一樣，方便統計；網址外流 1 分鐘後失效）。
 */
export async function downloadDocument(store: Store, storage: FileStorage, input: { tenant: TenantRow; documentId: string; member: MemberRow | null }): Promise<{ url: string; doc: DocumentRow }> {
  const d = await store.getDocument(input.tenant.id, input.documentId);
  if (!d || d.status !== "published" || !d.file_path) throw new ServiceError("not_found", "找不到文件");
  if (d.visibility === "members" && (!input.member || input.member.status !== "active")) throw new ServiceError("unauthorized", "這份文件限會員下載，請先登入");
  await store.bumpDownload(input.tenant.id, d.id);
  const url = await storage.signedDownloadUrl(d.file_path, DOWNLOAD_URL_SECONDS, d.file_name ?? "download");
  return { url, doc: d };
}
