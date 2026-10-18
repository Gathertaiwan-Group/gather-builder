-- 第五批：stored-value（儲值金）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 🔴 儲值帳本只增不改：service_role 只有 select／insert（update／delete／truncate 收回）。餘額＝帳本加總。
-- 只改 builder_apply_order_credits／builder_release_order_credits 內容（簽章不變），舊版程式不送 wallet_paid → 不受影響。

create table if not exists public.builder_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  -- topup 儲值入帳（＋；贈送額度可有到期日）／spend 消費（−）／refund 退回消費（＋）／expire 到期（−）／reverse 儲值訂單取消收回（−）／adjust 店主調整（±）
  kind text not null check (kind in ('topup', 'spend', 'refund', 'expire', 'reverse', 'adjust')),
  amount integer not null check (amount <> 0 and amount between -100000000 and 100000000),
  expires_at timestamptz,
  order_id uuid,
  ref text,
  reason text,
  actor text not null default 'system',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, ref),
  check (kind not in ('topup', 'refund') or amount > 0),
  check (kind not in ('spend', 'expire', 'reverse') or amount < 0)
);
create index if not exists builder_wallet_ledger_member_idx on public.builder_wallet_ledger (tenant_id, member_id, created_at);
create index if not exists builder_wallet_ledger_expiry_idx on public.builder_wallet_ledger (expires_at) where expires_at is not null;

-- 儲值方案：付 pay_amount 元 → 入帳 pay_amount（不到期）＋ bonus_amount 贈送額度（bonus_expire_days 天後到期，null＝不到期）
create table if not exists public.builder_topup_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  pay_amount integer not null check (pay_amount between 30 and 1000000),
  bonus_amount integer not null default 0 check (bonus_amount between 0 and 1000000),
  bonus_expire_days integer check (bonus_expire_days is null or bonus_expire_days between 1 and 3650),
  description text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_topup_plans_tenant_idx on public.builder_topup_plans (tenant_id, sort);

alter table public.builder_wallet_ledger enable row level security;
alter table public.builder_topup_plans enable row level security;
revoke all on table public.builder_wallet_ledger, public.builder_topup_plans from public, anon, authenticated;
grant select, insert on table public.builder_wallet_ledger to service_role;
revoke update, delete, truncate on table public.builder_wallet_ledger from service_role;
grant select, insert, update, delete on table public.builder_topup_plans to service_role;

-- 下單時的折抵／儲值金（0021 內容＋儲值金扣款）：簽章不變
create or replace function public.builder_apply_order_credits(p_tenant uuid, p_order uuid, p_input jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_member uuid := nullif(p_input->>'member_id', '')::uuid;
  v_points integer := coalesce((p_input->>'points_redeemed')::integer, 0);
  v_wallet integer := coalesce((p_input->>'wallet_paid')::integer, 0);
begin
  update public.builder_orders
     set tier_discount = coalesce((p_input->>'tier_discount')::integer, 0),
         points_redeemed = v_points,
         points_discount = coalesce((p_input->>'points_discount')::integer, 0),
         wallet_paid = v_wallet
   where id = p_order and tenant_id = p_tenant;
  if (v_points > 0 or v_wallet > 0) and v_member is null then
    raise exception 'builder: credits need member';
  end if;
  if v_points > 0 then
    perform public.builder_ledger_post('builder_points_ledger', p_tenant, v_member, 'redeem', -v_points, null,
      'order:' || p_order::text || ':redeem', p_order, '訂單折抵', 'checkout', '{}'::jsonb, 'strict');
  end if;
  if v_wallet > 0 then
    perform public.builder_ledger_post('builder_wallet_ledger', p_tenant, v_member, 'spend', -v_wallet, null,
      'order:' || p_order::text || ':spend', p_order, '訂單支付', 'checkout', '{}'::jsonb, 'strict');
  end if;
end;
$$;

-- 取消／逾期：退回這張訂單折抵的點數與支付的儲值金（冪等：ref 唯一）
create or replace function public.builder_release_order_credits(p_tenant uuid, p_order uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_o record;
begin
  select member_id, points_redeemed, wallet_paid into v_o from public.builder_orders where id = p_order and tenant_id = p_tenant;
  if v_o.member_id is null then
    return;
  end if;
  if v_o.points_redeemed > 0 and exists (select 1 from public.builder_points_ledger where tenant_id = p_tenant and ref = 'order:' || p_order::text || ':redeem') then
    perform public.builder_ledger_post('builder_points_ledger', p_tenant, v_o.member_id, 'reverse', v_o.points_redeemed, null,
      'order:' || p_order::text || ':redeem_refund', p_order, '訂單取消，退回折抵點數', 'system', '{}'::jsonb, 'credit');
  end if;
  if v_o.wallet_paid > 0 and exists (select 1 from public.builder_wallet_ledger where tenant_id = p_tenant and ref = 'order:' || p_order::text || ':spend') then
    perform public.builder_ledger_post('builder_wallet_ledger', p_tenant, v_o.member_id, 'refund', v_o.wallet_paid, null,
      'order:' || p_order::text || ':spend_refund', p_order, '訂單取消，退回儲值金', 'system', '{}'::jsonb, 'credit');
  end if;
end;
$$;

revoke all on function public.builder_apply_order_credits(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_release_order_credits(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_apply_order_credits(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_release_order_credits(uuid, uuid) to service_role;
