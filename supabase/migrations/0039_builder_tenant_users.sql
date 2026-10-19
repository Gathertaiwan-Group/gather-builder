-- 第九批（2）：店主後台帳號（不用 Supabase Auth：共用專案還住著其他客戶站）。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role；不動任何 Auth 設定。

-- 店主帳號（一個 email 一個帳號，可以屬於多個網站；密碼 scrypt，格式同會員；TOTP 秘密以 secretbox 加密、AAD 綁帳號 id）
create table if not exists public.builder_owner_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and char_length(email) between 3 and 254),
  name text check (name is null or char_length(name) <= 80),
  password_hash text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  totp_secret_enc text,
  totp_enabled_at timestamptz,
  -- 最後一次接受的 TOTP 時間步（防同一組碼重放）
  totp_last_step bigint,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 網站成員（邀請制）：角色 owner｜editor｜viewer；停用不刪
create table if not exists public.builder_tenant_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  user_id uuid not null references public.builder_owner_users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  status text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  invited_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists builder_tenant_users_user_idx on public.builder_tenant_users (user_id);

-- session：cookie 只放隨機 token，DB 存 sha256；可撤銷；閒置與絕對到期
create table if not exists public.builder_owner_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.builder_owner_users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text,
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists builder_owner_sessions_user_idx on public.builder_owner_sessions (user_id) where revoked_at is null;

-- 一次性 token：邀請（設定密碼）、重設密碼、二步驟登入暫存。只存 sha256；條件式 used_at is null 只用一次
create table if not exists public.builder_owner_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.builder_owner_users(id) on delete cascade,
  tenant_id uuid references public.builder_tenants(id) on delete cascade,
  purpose text not null check (purpose in ('invite', 'reset', 'mfa')),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists builder_owner_tokens_user_idx on public.builder_owner_tokens (user_id, purpose) where used_at is null;

alter table public.builder_owner_users enable row level security;
alter table public.builder_tenant_users enable row level security;
alter table public.builder_owner_sessions enable row level security;
alter table public.builder_owner_tokens enable row level security;
revoke all on table public.builder_owner_users, public.builder_tenant_users, public.builder_owner_sessions, public.builder_owner_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_owner_users, public.builder_tenant_users, public.builder_owner_sessions, public.builder_owner_tokens to service_role;
