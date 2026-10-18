-- members 模組：平台自管的會員帳號（不用 Supabase Auth）。
-- 每個租戶的會員分開存、分開登入：email 唯一性是 (tenant_id, email)，session 與 token 都帶 tenant_id。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  -- scrypt$N$r$p$salt$hash（參數寫進字串，日後可升級）
  password_hash text not null,
  name text check (name is null or char_length(name) <= 80),
  phone text check (phone is null or char_length(phone) <= 40),
  email_verified_at timestamptz,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  unique (tenant_id, email)
);
create index if not exists builder_members_tenant_idx on public.builder_members (tenant_id, created_at desc);

create table if not exists public.builder_member_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  -- 只存 sha256，cookie 裡的原文不落地
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  ua text
);
create index if not exists builder_member_sessions_member_idx on public.builder_member_sessions (member_id);

create table if not exists public.builder_member_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'reset_password')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists builder_member_tokens_member_idx on public.builder_member_tokens (member_id, purpose);

alter table public.builder_members enable row level security;
alter table public.builder_member_sessions enable row level security;
alter table public.builder_member_tokens enable row level security;

revoke all on table public.builder_members, public.builder_member_sessions, public.builder_member_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_members, public.builder_member_sessions, public.builder_member_tokens to service_role;
