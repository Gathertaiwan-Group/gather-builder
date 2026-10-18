-- invoice 模組（電子發票）：每租戶憑證＋每訂單一張發票（order_id 唯一 → 自動開票冪等的 DB 保證）。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_invoice_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.builder_tenants(id) on delete cascade,
  provider text not null check (provider in ('amego', 'mock')),
  seller_tax_id text not null check (seller_tax_id ~ '^[0-9]{8}$'),
  -- AES-256-GCM（PAYMENT_ENC_KEY），AAD 綁 tenant_id；DB 裡沒有明文
  secret_enc text not null,
  status text not null default 'unverified' check (status in ('unverified', 'verified')),
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.builder_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  -- 🔴 同一張訂單只會有一張發票（自動開立重複觸發也只會建一列）
  order_id uuid not null unique references public.builder_orders(id) on delete cascade,
  provider text not null check (provider in ('amego', 'mock')),
  -- issuing = 已宣告、正在呼叫供應商（claim-then-act；卡住的會在逾時後以「先反查」重新宣告）
  status text not null default 'pending' check (status in ('pending', 'issuing', 'issued', 'failed', 'voided', 'allowance')),
  amount integer not null check (amount >= 0),
  invoice_no text,
  random_number text,
  invoice_date text,
  raw jsonb,
  error text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  issued_at timestamptz,
  voided_at timestamptz,
  allowance_no text,
  allowance_amount integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists builder_invoices_no_idx on public.builder_invoices (tenant_id, invoice_no) where invoice_no is not null;
create index if not exists builder_invoices_retry_idx on public.builder_invoices (status, attempts) where status in ('pending', 'failed');

alter table public.builder_invoice_accounts enable row level security;
alter table public.builder_invoices enable row level security;
revoke all on table public.builder_invoice_accounts, public.builder_invoices from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_invoice_accounts, public.builder_invoices to service_role;
