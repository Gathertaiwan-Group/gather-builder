-- 第六批：certificates（證照查詢）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role。
-- 生日是「查詢條件」不是輸出：查詢結果永遠不回傳生日；查詢紀錄只增不改（service_role 只有 select／insert）。

create table if not exists public.builder_certificates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  -- 正規化證號（全形轉半形、大寫、去空白與分隔符號）＝比對鍵；cert_no_display 為原樣顯示
  cert_no text not null check (cert_no ~ '^[A-Z0-9]{3,40}$'),
  cert_no_display text not null check (char_length(cert_no_display) between 3 and 60),
  name text not null check (char_length(name) between 1 and 80),
  -- 正規化姓名（NFKC、去空白）
  name_norm text not null check (char_length(name_norm) between 1 and 80),
  birth_date date not null,
  category text check (category is null or char_length(category) <= 80),
  issued_on date,
  expires_on date,
  status text not null default 'valid' check (status in ('valid', 'revoked', 'suspended')),
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, cert_no)
);
create index if not exists builder_certificates_name_idx on public.builder_certificates (tenant_id, name_norm, birth_date);

create table if not exists public.builder_cert_lookups (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  mode text not null check (mode in ('cert_no', 'name_birth')),
  ip_hash text,
  found boolean not null,
  -- 只記查詢鍵的雜湊（不存姓名、生日原文）
  key_hash text,
  at timestamptz not null default now()
);
create index if not exists builder_cert_lookups_tenant_idx on public.builder_cert_lookups (tenant_id, at desc);

alter table public.builder_certificates enable row level security;
alter table public.builder_cert_lookups enable row level security;
revoke all on table public.builder_certificates, public.builder_cert_lookups from public, anon, authenticated;
revoke all on sequence public.builder_cert_lookups_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_certificates to service_role;
grant select, insert on table public.builder_cert_lookups to service_role;
revoke update, delete, truncate on table public.builder_cert_lookups from service_role;
grant usage on sequence public.builder_cert_lookups_id_seq to service_role;
