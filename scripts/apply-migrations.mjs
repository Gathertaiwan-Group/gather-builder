#!/usr/bin/env node
// 透過 Supabase Management API 套用 supabase/migrations/*.sql。
// 🔴 不用 `supabase db push`：這個 Supabase 專案與其他站共用，db push 會試圖對齊整個 schema。
//
// 用法：SUPABASE_ACCESS_TOKEN=... [SUPABASE_PROJECT_REF=...] node scripts/apply-migrations.mjs [--dry-run]
// 每支 migration 與它的紀錄列在同一個請求（＝同一個交易）裡執行，失敗整支回滾。
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF || "ozwftlkgqmewtadypsfi";
const dryRun = process.argv.includes("--dry-run");
if (!token) {
  console.error("缺少 SUPABASE_ACCESS_TOKEN");
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Management API 前面的 WAF 會擋沒有瀏覽器 UA 的請求
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

await query(`create table if not exists public.builder_schema_migrations (
  name text primary key, applied_at timestamptz not null default now());
alter table public.builder_schema_migrations enable row level security;
revoke all on table public.builder_schema_migrations from anon, authenticated;`);

const applied = new Set((await query("select name from public.builder_schema_migrations")).map((r) => r.name));
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

for (const f of files) {
  if (applied.has(f)) {
    console.log(`skip   ${f}`);
    continue;
  }
  const sql = readFileSync(join(dir, f), "utf8");
  if (dryRun) {
    console.log(`would apply ${f}`);
    continue;
  }
  await query(`${sql}\n;insert into public.builder_schema_migrations(name) values (${lit(f)});`);
  console.log(`apply  ${f}`);
}
console.log("done");
