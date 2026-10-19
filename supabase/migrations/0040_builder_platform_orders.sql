-- 第九批（3）：/build 組裝器＋平台收費＋付款後自動開站。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。這是「平台」自己的訂單（平台向店主收費），
--    與租戶網站的 builder_orders（店主向客人收費）完全分開。

create table if not exists public.builder_platform_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique check (order_no ~ '^GP-[0-9]{8}-[A-Z0-9]{6}$'),
  kind text not null check (kind in ('new_site', 'add_modules', 'renewal')),
  tenant_id uuid references public.builder_tenants(id) on delete set null,
  -- new_site：想要的網址代號、品牌名、版型
  slug text check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  brand_name text check (brand_name is null or char_length(brand_name) between 1 and 120),
  theme_preset text check (theme_preset is null or char_length(theme_preset) <= 40),
  contact_email text not null check (char_length(contact_email) between 3 and 254),
  -- 這張單要開通的模組（已含依賴、已扣除租戶已有的）與 server 算出的金額（前端送的價格一律不採信）
  modules text[] not null default '{}',
  amount_setup integer not null check (amount_setup >= 0),
  amount_monthly integer not null check (amount_monthly >= 0),
  amount_total integer not null check (amount_total >= 0),
  -- renewal：涵蓋的期間
  period_start timestamptz,
  period_end timestamptz,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'expired', 'cancelled')),
  sandbox boolean not null default false,
  is_test boolean not null default false,
  access_key_hash text not null check (access_key_hash ~ '^[0-9a-f]{64}$'),
  gateway_order_no text unique check (gateway_order_no is null or gateway_order_no ~ '^[A-Za-z0-9]{1,20}$'),
  payment_url text,
  paid_at timestamptz,
  paid_amount integer,
  query_failures integer not null default 0,
  -- 開站／開通（冪等、可重試）：none → provisioning（宣告）→ done｜failed
  provision_state text not null default 'none' check (provision_state in ('none', 'provisioning', 'done', 'failed')),
  provision_claimed_at timestamptz,
  provision_attempts integer not null default 0,
  provision_error text,
  provisioned_at timestamptz,
  alerted_at timestamptz,
  expires_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 同一個網址代號同時只能有一張進行中（待付款／已付款）的開站單
create unique index if not exists builder_platform_orders_live_slug on public.builder_platform_orders (slug) where kind = 'new_site' and status in ('pending_payment', 'paid');
-- 同一個租戶同一期只能有一張續費單
create unique index if not exists builder_platform_orders_renewal_period on public.builder_platform_orders (tenant_id, period_start) where kind = 'renewal' and status in ('pending_payment', 'paid');
create index if not exists builder_platform_orders_tenant_idx on public.builder_platform_orders (tenant_id, created_at desc);
create index if not exists builder_platform_orders_sweep_idx on public.builder_platform_orders (status, expires_at);

-- 🔴 一張平台訂單只開一個站：租戶上記開站訂單 id（unique）
alter table public.builder_tenants add column if not exists platform_order_id uuid references public.builder_platform_orders(id) on delete set null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'builder_tenants_platform_order_id_key') then
    alter table public.builder_tenants add constraint builder_tenants_platform_order_id_key unique (platform_order_id);
  end if;
end $$;

-- 平台向租戶收月費的狀態（只有經 /build 開的站才有；手動建的站沒有這列＝不受平台收費控管）
create table if not exists public.builder_tenant_billing (
  tenant_id uuid primary key references public.builder_tenants(id) on delete cascade,
  -- 已購買的模組（停用後可重新啟用不用再付建置費）
  modules text[] not null default '{}',
  monthly_amount integer not null check (monthly_amount >= 0),
  status text not null default 'active' check (status in ('active', 'past_due', 'suspended', 'cancelled')),
  paid_until timestamptz not null,
  grace_until timestamptz,
  cancel_at_period_end boolean not null default false,
  suspended_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_tenant_billing_due_idx on public.builder_tenant_billing (status, paid_until);

alter table public.builder_platform_orders enable row level security;
alter table public.builder_tenant_billing enable row level security;
revoke all on table public.builder_platform_orders, public.builder_tenant_billing from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_platform_orders, public.builder_tenant_billing to service_role;
