import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../store/supabase";

/**
 * 檔案儲存（downloads 模組）。🔴 共用 Supabase 專案：只用 builder- 開頭的私有 bucket（scripts/ensure-buckets.mjs 建立），
 * 物件路徑一律 <tenant_id>/<document_id>/<檔名>；下載只給短效簽名網址。
 */
export const DOWNLOADS_BUCKET = "builder-downloads";

export interface FileStorage {
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** 簽名上傳網址（大檔直傳，不經 Vercel 的 4.5MB body 限制）：PUT 檔案到 url */
  signedUploadUrl(path: string): Promise<{ url: string; token: string }>;
  signedDownloadUrl(path: string, seconds: number, downloadName: string): Promise<string>;
  stat(path: string): Promise<{ size: number; contentType: string | null } | null>;
}

export function supabaseFileStorage(db: SupabaseClient = createServiceClient(), bucket = DOWNLOADS_BUCKET): FileStorage {
  if (!bucket.startsWith("builder-")) throw new Error("只能使用 builder- 開頭的 bucket");
  const b = () => db.storage.from(bucket);
  return {
    async upload(path, bytes, contentType) {
      const r = await b().upload(path, bytes, { contentType, upsert: false });
      if (r.error) throw new Error(`storage upload: ${r.error.message}`);
    },
    async signedUploadUrl(path) {
      const r = await b().createSignedUploadUrl(path);
      if (r.error || !r.data) throw new Error(`storage signed upload: ${r.error?.message}`);
      return { url: r.data.signedUrl, token: r.data.token };
    },
    async signedDownloadUrl(path, seconds, downloadName) {
      const r = await b().createSignedUrl(path, seconds, { download: downloadName });
      if (r.error || !r.data) throw new Error(`storage signed url: ${r.error?.message}`);
      return r.data.signedUrl;
    },
    async stat(path) {
      const i = path.lastIndexOf("/");
      const r = await b().list(path.slice(0, i), { search: path.slice(i + 1), limit: 10 });
      if (r.error) throw new Error(`storage list: ${r.error.message}`);
      const hit = (r.data ?? []).find((f) => f.name === path.slice(i + 1));
      if (!hit) return null;
      const meta = (hit.metadata ?? {}) as { size?: number; mimetype?: string };
      return { size: Number(meta.size ?? 0), contentType: meta.mimetype ?? null };
    },
  };
}

export type MemoryFileStorage = FileStorage & {
  files: Map<string, { bytes: Uint8Array; contentType: string }>;
  putSigned(token: string, bytes: Uint8Array, contentType: string): void;
  fetchSigned(url: string, now?: number): { status: number; bytes?: Uint8Array };
};

/** 測試用：記憶體儲存；簽名網址帶到期時間，fetchSigned 過期回 400 */
export function memoryFileStorage(): MemoryFileStorage {
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const uploads = new Map<string, string>();
  return {
    files,
    async upload(path, bytes, contentType) {
      if (files.has(path)) throw new Error("exists");
      files.set(path, { bytes, contentType });
    },
    async signedUploadUrl(path) {
      const token = Math.random().toString(36).slice(2);
      uploads.set(token, path);
      return { url: `memory://upload/${token}`, token };
    },
    putSigned(token, bytes, contentType) {
      const p = uploads.get(token);
      if (!p) throw new Error("bad token");
      files.set(p, { bytes, contentType });
      uploads.delete(token);
    },
    async signedDownloadUrl(path, seconds, downloadName) {
      return `memory://download/${encodeURIComponent(path)}?exp=${Date.now() + seconds * 1000}&name=${encodeURIComponent(downloadName)}`;
    },
    fetchSigned(url, now = Date.now()) {
      const u = new URL(url.replace("memory://", "http://m/"));
      if (Number(u.searchParams.get("exp")) < now) return { status: 400 };
      const f = files.get(decodeURIComponent(u.pathname.replace("/download/", "")));
      return f ? { status: 200, bytes: f.bytes } : { status: 404 };
    },
    async stat(path) {
      const f = files.get(path);
      return f ? { size: f.bytes.length, contentType: f.contentType } : null;
    },
  };
}

let cached: FileStorage | null = null;
export function getFileStorage(): FileStorage {
  if (!cached) cached = supabaseFileStorage();
  return cached;
}
