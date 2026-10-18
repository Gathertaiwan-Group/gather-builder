-- referral 模組（推薦）：每會員一組推薦碼、推薦關係（同一被推薦人只觸發一次）、KOL 分潤帳（只增不改）。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_referral_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{4,16}$'),
  -- KOL 分潤比例（萬分比；0 = 不分潤，上限 50%）
  kol_rate_bp integer not null default 0 check (kol_rate_bp between 0 and 5000),
  created_at timestamptz not null default now(),
  unique (tenant_id, member_id),
  unique (tenant_id, code)
);

create table if not exists public.builder_referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  referrer_member_id uuid not null references public.builder_members(id) on delete cascade,
  referee_key text not null,
  referee_member_id uuid references public.builder_members(id) on delete set null,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  reward_coupon_id uuid references public.builder_coupons(id) on delete set null,
  created_at timestamptz not null default now(),
  -- 🔴 同一個被推薦人只會觸發一次回饋
  unique (tenant_id, referee_key)
);

-- 分潤帳：只增不改（service_role 只有 select、insert；沖回是另一筆 reverse）
create table if not exists public.builder_referral_ledger (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  referrer_member_id uuid not null references public.builder_members(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  kind text not null check (kind in ('earn', 'reverse')),
  amount integer not null,
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);
create index if not exists builder_referral_ledger_tenant_idx on public.builder_referral_ledger (tenant_id, referrer_member_id);

alter table public.builder_referral_codes enable row level security;
alter table public.builder_referrals enable row level security;
alter table public.builder_referral_ledger enable row level security;
revoke all on table public.builder_referral_codes, public.builder_referrals, public.builder_referral_ledger from public, anon, authenticated;
revoke all on sequence public.builder_referral_ledger_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_referral_codes, public.builder_referrals to service_role;
grant select, insert on table public.builder_referral_ledger to service_role;
grant usage on sequence public.builder_referral_ledger_id_seq to service_role;
