#!/usr/bin/env node
// 建立 gather-builder 需要的 Storage bucket（冪等）。🔴 共用專案：只建立／查看 builder- 開頭的 bucket，絕不碰其他 bucket。
// 用法：node --env-file=.env.local scripts/ensure-buckets.mjs
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const BUCKETS = [
  // downloads 模組：私有，下載一律走短效簽名網址；單檔上限 50MB（大於 4MB 的檔案走簽名上傳網址直傳，不經 Vercel）
  { id: "builder-downloads", public: false, file_size_limit: 50 * 1024 * 1024 },
];
const h = { Authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" };
for (const b of BUCKETS) {
  if (!b.id.startsWith("builder-")) throw new Error(`拒絕：${b.id} 不是 builder- 開頭`);
  const get = await fetch(`${url}/storage/v1/bucket/${b.id}`, { headers: h });
  if (get.ok) {
    const cur = await get.json();
    console.log(`exists ${b.id} public=${cur.public} limit=${cur.file_size_limit}`);
    if (cur.public !== b.public || cur.file_size_limit !== b.file_size_limit) {
      const put = await fetch(`${url}/storage/v1/bucket/${b.id}`, { method: "PUT", headers: h, body: JSON.stringify({ public: b.public, file_size_limit: b.file_size_limit }) });
      console.log(`update ${b.id} → ${put.status}`);
    }
    continue;
  }
  const res = await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: h, body: JSON.stringify({ id: b.id, name: b.id, public: b.public, file_size_limit: b.file_size_limit }) });
  console.log(`create ${b.id} → ${res.status} ${res.ok ? "" : (await res.text()).slice(0, 200)}`);
}
