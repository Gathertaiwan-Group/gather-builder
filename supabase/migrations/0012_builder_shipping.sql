-- shipping 模組（物流）：綠界物流憑證、超商電子地圖選店暫存、出貨單。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_shipping_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.builder_tenants(id) on delete cascade,
  provider text not null check (provider in ('ecpay')),
  merchant_id text not null check (merchant_id ~ '^[0-9A-Za-z]{1,10}$'),
  -- JSON {hashKey, hashIv} 的 AES-256-GCM 密文（AAD 綁 tenant_id）
  secret_enc text not null,
  stage boolean not null default true,
  kind text not null default 'C2C' check (kind in ('C2C', 'B2C')),
  status text not null default 'unverified' check (status in ('unverified', 'verified')),
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 電子地圖選店暫存：MerchantTradeNo（隨機、只在瀏覽器與綠界之間）的 sha256 是查詢鍵，
-- binding_hash 綁這次結帳的瀏覽器秘密；下單時要兩者都對才消耗（不能綁到別人的結帳）。
create table if not exists public.builder_cvs_selections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  trade_no_hash text not null unique,
  binding_hash text not null,
  sub_type text not null,
  method_id text not null,
  store jsonb,
  selected_at timestamptz,
  expires_at timestamptz not null,
  used_at timestamptz,
  order_id uuid references public.builder_orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists builder_cvs_selections_tenant_idx on public.builder_cvs_selections (tenant_id, created_at desc);

create table if not exists public.builder_shipments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  method_id text not null,
  method_type text not null check (method_type in ('cvs', 'home', 'pickup', 'manual')),
  provider text not null check (provider in ('ecpay', 'manual')),
  sub_type text,
  merchant_trade_no text unique,
  logistics_id text,
  store jsonb,
  tracking_no text,
  validation_no text,
  status text not null default 'created' check (status in ('created', 'in_transit', 'arrived', 'delivered', 'returned', 'failed', 'cancelled')),
  stage boolean not null default false,
  raw jsonb,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 同一訂單只能有一張有效出貨單
create unique index if not exists builder_shipments_active_order_idx on public.builder_shipments (order_id) where status not in ('failed', 'cancelled');
create index if not exists builder_shipments_tenant_idx on public.builder_shipments (tenant_id, created_at desc);

alter table public.builder_shipping_accounts enable row level security;
alter table public.builder_cvs_selections enable row level security;
alter table public.builder_shipments enable row level security;
revoke all on table public.builder_shipping_accounts, public.builder_cvs_selections, public.builder_shipments from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_shipping_accounts, public.builder_cvs_selections, public.builder_shipments to service_role;
