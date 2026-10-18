-- 第七批：多家金流 provider（藍新、綠界金流、LINE Pay、黑貓 PAY、PAYUNi）＋退款紀錄。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role；不碰其他站的物件。
-- 全部是「放寬 check／加欄位（有預設值）／新表」，線上舊版程式可照常運作（不需相容層）。

-- 訂單付款方式：每家 provider 一個值（線上付款＝provider id）
alter table public.builder_orders drop constraint if exists builder_orders_payment_method_check;
alter table public.builder_orders add constraint builder_orders_payment_method_check
  check (payment_method in ('pchomepay', 'newebpay', 'ecpay', 'linepay', 'blackcat', 'payuni', 'offline', 'credit'));

alter table public.builder_payment_accounts drop constraint if exists builder_payment_accounts_provider_check;
alter table public.builder_payment_accounts add constraint builder_payment_accounts_provider_check
  check (provider in ('pchomepay', 'newebpay', 'ecpay', 'linepay', 'blackcat', 'payuni'));

alter table public.builder_payments drop constraint if exists builder_payments_provider_check;
alter table public.builder_payments add constraint builder_payments_provider_check
  check (provider in ('pchomepay', 'newebpay', 'ecpay', 'linepay', 'blackcat', 'payuni'));

-- provider 的交易序號（LINE Pay transactionId 19 位數 → 一律存字串）
alter table public.builder_payments add column if not exists gateway_trade_no text;
-- LINE Pay confirm 的條件式宣告（同一 transactionId 只 confirm 一次；卡住 2 分鐘可重新宣告）
alter table public.builder_payments add column if not exists confirm_claimed_at timestamptz;
alter table public.builder_payments add column if not exists confirm_attempts integer not null default 0;

-- 退款：一筆付款只能有一筆「進行中／成功／結果不明」的退款（partial unique index＝只能退一次）
create table if not exists public.builder_refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  payment_id uuid not null references public.builder_payments(id) on delete cascade,
  provider text not null check (provider in ('pchomepay', 'newebpay', 'ecpay', 'linepay', 'blackcat', 'payuni')),
  amount integer not null check (amount > 0),
  -- requested 已宣告、正在呼叫 provider／succeeded 成功／failed 確定失敗（可重新申請）／unknown 結果不明（需人工確認，不自動重送）
  status text not null default 'requested' check (status in ('requested', 'succeeded', 'failed', 'unknown')),
  requested_by text not null,
  reason text,
  provider_refund_no text,
  error text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists builder_refunds_once_idx on public.builder_refunds (payment_id) where status in ('requested', 'succeeded', 'unknown');
create index if not exists builder_refunds_order_idx on public.builder_refunds (tenant_id, order_id);

alter table public.builder_refunds enable row level security;
revoke all on table public.builder_refunds from public, anon, authenticated;
grant select, insert, update on table public.builder_refunds to service_role;
-- 退款紀錄不可刪（只會改狀態）
revoke delete, truncate on table public.builder_refunds from service_role;

revoke all on table public.builder_orders, public.builder_payments, public.builder_payment_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_orders, public.builder_payments, public.builder_payment_accounts to service_role;
