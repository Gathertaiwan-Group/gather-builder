-- gather-builder 初始 schema
-- 🔴 這個 Supabase 專案與其他客戶站共用：所有物件一律 builder_ 前綴、放 public。
--    全部開 RLS 且不建任何 anon/authenticated policy；server 端一律用 service role。
--    額外 revoke anon/authenticated 的表與函式權限（Supabase 預設會 grant）。

create table if not exists public.builder_tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'trial' check (status in ('trial', 'active', 'suspended')),
  theme jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  published_revision_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.builder_tenant_modules (
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  module_id text not null,
  status text not null check (status in ('enabled', 'pending_setup', 'disabled')),
  config jsonb not null default '{}'::jsonb,
  enabled_at timestamptz,
  primary key (tenant_id, module_id)
);

create table if not exists public.builder_site_drafts (
  tenant_id uuid primary key references public.builder_tenants(id) on delete cascade,
  content jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null
);

create table if not exists public.builder_site_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  number integer not null check (number > 0),
  content jsonb not null,
  note text,
  published_by text not null,
  published_at timestamptz not null default now(),
  unique (tenant_id, number)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'builder_tenants_published_revision_fk') then
    alter table public.builder_tenants
      add constraint builder_tenants_published_revision_fk
      foreign key (published_revision_id) references public.builder_site_revisions(id) on delete set null;
  end if;
end $$;

create table if not exists public.builder_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$|^[a-z0-9]$'),
  title text not null,
  excerpt text,
  body_md text not null default '',
  cover_url text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists builder_posts_tenant_idx on public.builder_posts (tenant_id, status, published_at desc);

create table if not exists public.builder_portfolio_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  title text not null,
  description text,
  image_url text not null,
  link_url text,
  tags text[] not null default '{}',
  sort integer not null default 0,
  status text not null default 'published' check (status in ('draft', 'published')),
  created_at timestamptz not null default now()
);
create index if not exists builder_portfolio_tenant_idx on public.builder_portfolio_items (tenant_id, sort);

create table if not exists public.builder_inquiries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  message text not null,
  source_path text,
  ip_hash text,
  status text not null default 'new' check (status in ('new', 'read', 'archived')),
  created_at timestamptz not null default now()
);
create index if not exists builder_inquiries_tenant_idx on public.builder_inquiries (tenant_id, created_at desc);
create index if not exists builder_inquiries_ip_idx on public.builder_inquiries (tenant_id, ip_hash, created_at desc);

create table if not exists public.builder_line_clicks (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  path text,
  placement text,
  ip_hash text,
  user_agent text,
  at timestamptz not null default now()
);
create index if not exists builder_line_clicks_tenant_idx on public.builder_line_clicks (tenant_id, at desc);

create table if not exists public.builder_api_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.builder_tenants(id) on delete cascade, -- null = 平台級
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists builder_api_tokens_tenant_idx on public.builder_api_tokens (tenant_id);

-- 稽核紀錄刻意不設 tenant FK：租戶刪掉後紀錄仍要留著。
create table if not exists public.builder_audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  actor text not null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists builder_audit_tenant_idx on public.builder_audit_log (tenant_id, at desc);

-- 發布：把目前草稿凍結成下一個版本號，並設為已發布（單一交易、鎖租戶列避免版本號競爭）。
create or replace function public.builder_publish(p_tenant uuid, p_note text, p_actor text)
returns table (revision_id uuid, revision_number integer)
language plpgsql
set search_path = public
as $$
declare
  v_content jsonb;
  v_number integer;
  v_id uuid;
begin
  perform 1 from public.builder_tenants where id = p_tenant for update;
  if not found then
    raise exception 'builder: tenant % not found', p_tenant;
  end if;
  select d.content into v_content from public.builder_site_drafts d where d.tenant_id = p_tenant;
  if v_content is null then
    raise exception 'builder: draft for tenant % not found', p_tenant;
  end if;
  select coalesce(max(r.number), 0) + 1 into v_number
    from public.builder_site_revisions r where r.tenant_id = p_tenant;
  insert into public.builder_site_revisions (tenant_id, number, content, note, published_by)
    values (p_tenant, v_number, v_content, p_note, p_actor)
    returning id into v_id;
  update public.builder_tenants
     set published_revision_id = v_id,
         theme = coalesce(v_content -> 'theme', '{}'::jsonb)
   where id = p_tenant;
  return query select v_id, v_number;
end;
$$;

-- 還原：把指定版本設為已發布，並把該版內容同步回草稿（不新增版本）。
create or replace function public.builder_rollback(p_tenant uuid, p_number integer, p_actor text)
returns table (revision_id uuid, revision_number integer)
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_content jsonb;
begin
  perform 1 from public.builder_tenants where id = p_tenant for update;
  if not found then
    raise exception 'builder: tenant % not found', p_tenant;
  end if;
  select r.id, r.content into v_id, v_content
    from public.builder_site_revisions r
   where r.tenant_id = p_tenant and r.number = p_number;
  if v_id is null then
    return;
  end if;
  update public.builder_tenants
     set published_revision_id = v_id,
         theme = coalesce(v_content -> 'theme', '{}'::jsonb)
   where id = p_tenant;
  insert into public.builder_site_drafts (tenant_id, content, updated_at, updated_by)
    values (p_tenant, v_content, now(), p_actor)
    on conflict (tenant_id) do update
      set content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
  return query select v_id, p_number;
end;
$$;

-- RLS：全開、不建 policy。
alter table public.builder_tenants enable row level security;
alter table public.builder_tenant_modules enable row level security;
alter table public.builder_site_drafts enable row level security;
alter table public.builder_site_revisions enable row level security;
alter table public.builder_posts enable row level security;
alter table public.builder_portfolio_items enable row level security;
alter table public.builder_inquiries enable row level security;
alter table public.builder_line_clicks enable row level security;
alter table public.builder_api_tokens enable row level security;
alter table public.builder_audit_log enable row level security;

revoke all on table
  public.builder_tenants, public.builder_tenant_modules, public.builder_site_drafts,
  public.builder_site_revisions, public.builder_posts, public.builder_portfolio_items,
  public.builder_inquiries, public.builder_line_clicks, public.builder_api_tokens,
  public.builder_audit_log
  from anon, authenticated;
revoke all on sequence public.builder_line_clicks_id_seq, public.builder_audit_log_id_seq from anon, authenticated;

revoke all on function public.builder_publish(uuid, text, text) from public, anon, authenticated;
revoke all on function public.builder_rollback(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.builder_publish(uuid, text, text) to service_role;
grant execute on function public.builder_rollback(uuid, integer, text) to service_role;
