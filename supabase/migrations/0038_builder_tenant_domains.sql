-- 第九批（1）：子網域與自有網域。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role；不動任何專案層級設定。

-- 租戶的正式網域（自有網域啟用後＝那個網域；null＝子網域或 /s/<slug>）。middleware 讀它決定子網域要不要 301 過去。
alter table public.builder_tenants add column if not exists primary_domain text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'builder_tenants_primary_domain_key') then
    alter table public.builder_tenants add constraint builder_tenants_primary_domain_key unique (primary_domain);
  end if;
end $$;

-- 自有網域：一個網域只屬於一個租戶（unique）；只有 status=active 的網域會被 middleware 對應到租戶。
create table if not exists public.builder_tenant_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  domain text not null unique check (domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' and char_length(domain) <= 253),
  status text not null default 'pending' check (status in ('pending', 'verified', 'active')),
  -- 驗證方式：vercel（由 Vercel 專案網域 API 驗證 DNS）
  verify_method text not null default 'vercel' check (verify_method in ('vercel')),
  -- 要請店主設定的 DNS 記錄（[{type, name, value, reason}]）
  dns_records jsonb not null default '[]'::jsonb,
  last_checked_at timestamptz,
  last_error text,
  verified_at timestamptz,
  activated_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_tenant_domains_tenant_idx on public.builder_tenant_domains (tenant_id);
create index if not exists builder_tenant_domains_pending_idx on public.builder_tenant_domains (status, last_checked_at) where status = 'pending';
-- 每個租戶同時只能有一個啟用中的網域（＝primary_domain）
create unique index if not exists builder_tenant_domains_one_active on public.builder_tenant_domains (tenant_id) where status = 'active';

alter table public.builder_tenant_domains enable row level security;
revoke all on table public.builder_tenant_domains from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_tenant_domains to service_role;

-- 啟用網域（單一交易）：把租戶其他 active 降為 verified → 這個 verified → active → 寫 builder_tenants.primary_domain
create or replace function public.builder_activate_domain(p_tenant uuid, p_domain_id uuid)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_domain text;
begin
  perform 1 from public.builder_tenants where id = p_tenant for update;
  select domain into v_domain from public.builder_tenant_domains
   where id = p_domain_id and tenant_id = p_tenant and status in ('verified', 'active') for update;
  if v_domain is null then
    raise exception 'builder: domain not verified';
  end if;
  update public.builder_tenant_domains set status = 'verified', updated_at = now()
   where tenant_id = p_tenant and status = 'active' and id <> p_domain_id;
  update public.builder_tenant_domains set status = 'active', activated_at = coalesce(activated_at, now()), updated_at = now()
   where id = p_domain_id;
  update public.builder_tenants set primary_domain = v_domain where id = p_tenant;
  return v_domain;
end;
$$;
revoke all on function public.builder_activate_domain(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_activate_domain(uuid, uuid) to service_role;
