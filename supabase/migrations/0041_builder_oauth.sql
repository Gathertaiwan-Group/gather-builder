-- 第九批（4）：MCP OAuth 2.1（authorization code＋PKCE S256；DCR 與 Client ID Metadata Documents；refresh token 輪替＋重用偵測）。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。所有 code／token 只存 sha256。

create table if not exists public.builder_oauth_clients (
  id uuid primary key default gen_random_uuid(),
  -- DCR：gbc_<隨機>；CIMD：client metadata 文件的 https 網址
  client_id text not null unique check (char_length(client_id) between 8 and 500),
  kind text not null check (kind in ('dcr', 'cimd')),
  client_name text check (client_name is null or char_length(client_name) <= 200),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  metadata jsonb not null default '{}'::jsonb,
  created_ip_hash text,
  fetched_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

-- 授權（同意紀錄）：店主帳號 × 網站 × client × scopes；撤銷＝底下所有 token 立即失效
create table if not exists public.builder_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.builder_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references public.builder_owner_users(id) on delete cascade,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  scopes text[] not null,
  resource text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists builder_oauth_grants_tenant_idx on public.builder_oauth_grants (tenant_id, created_at desc);
create index if not exists builder_oauth_grants_user_idx on public.builder_oauth_grants (user_id);

-- 授權碼：一次性、2 分鐘；綁 client、redirect_uri、PKCE challenge、resource
create table if not exists public.builder_oauth_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  grant_id uuid not null references public.builder_oauth_grants(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes text[] not null,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- access（1 小時）／refresh（30 天、每次使用就輪替；已用過的再出現＝重用 → 整個授權撤銷）
create table if not exists public.builder_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('access', 'refresh')),
  grant_id uuid not null references public.builder_oauth_grants(id) on delete cascade,
  client_id text not null,
  scopes text[] not null,
  resource text not null,
  parent_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists builder_oauth_tokens_grant_idx on public.builder_oauth_tokens (grant_id);

alter table public.builder_oauth_clients enable row level security;
alter table public.builder_oauth_grants enable row level security;
alter table public.builder_oauth_codes enable row level security;
alter table public.builder_oauth_tokens enable row level security;
revoke all on table public.builder_oauth_clients, public.builder_oauth_grants, public.builder_oauth_codes, public.builder_oauth_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_oauth_clients, public.builder_oauth_grants, public.builder_oauth_codes, public.builder_oauth_tokens to service_role;
