-- 第七批：subscriptions（訂閱制定期扣款，第一個 provider：藍新信用卡定期定額）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role；函式固定 search_path。
-- 每期扣款紀錄只增不改：service_role 只有 select／insert（update／delete／truncate 收回），unique(訂閱, 期數, 結果) 保證同一期只入帳一次。
-- 狀態機：pending → active → past_due → cancelled／expired（cancelled、expired 為終點）。所有轉換都是條件式（where status in 允許的來源）。

create table if not exists public.builder_subscription_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  amount integer not null check (amount between 30 and 2000000),
  interval text not null check (interval in ('month', 'year')),
  trial_days integer not null default 0 check (trial_days between 0 and 28),
  -- 期數上限（藍新最多 99 期）
  total_periods integer not null default 99 check (total_periods between 1 and 99),
  -- 權益：{ "kind": "none" } 或 { "kind": "course", "courseId": "<uuid>" }
  entitlement jsonb not null default '{"kind":"none"}'::jsonb,
  provider text not null default 'newebpay' check (provider in ('newebpay')),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  description text not null default '' check (char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_subscription_plans_tenant_idx on public.builder_subscription_plans (tenant_id, status);

create table if not exists public.builder_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  plan_id uuid not null references public.builder_subscription_plans(id) on delete restrict,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  provider text not null check (provider in ('newebpay')),
  sandbox boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'active', 'past_due', 'cancelled', 'expired')),
  -- 建立委託時的商店訂單編號（藍新 MerOrderNo，英數＿≤30，全平台唯一）
  merchant_order_no text not null unique,
  -- 藍新委託單號 PeriodNo（建立成功後才有）
  period_no text,
  amount integer not null check (amount > 0),
  interval text not null check (interval in ('month', 'year')),
  total_periods integer not null,
  current_period_end timestamptz,
  grace_until timestamptz,
  failed_count integer not null default 0,
  last_charge_at timestamptz,
  -- 終止委託（會員取消）：requested → done／failed（可重試，記次數與錯誤）
  cancel_state text not null default 'none' check (cancel_state in ('none', 'requested', 'done', 'failed')),
  cancel_attempts integer not null default 0,
  cancel_error text,
  cancel_requested_at timestamptz,
  -- 權益開通狀態（none → granted → revoked；冪等）；entitlement_ref 記開通的實體（例如 enrollment id）
  entitlement_state text not null default 'none' check (entitlement_state in ('none', 'granted', 'revoked')),
  entitlement_ref jsonb,
  query_failures integer not null default 0,
  alerted_at timestamptz,
  activated_at timestamptz,
  cancelled_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 同一會員同一方案只能有一筆「進行中」的訂閱
create unique index if not exists builder_subscriptions_live_idx on public.builder_subscriptions (tenant_id, plan_id, member_id) where status in ('pending', 'active', 'past_due');
create index if not exists builder_subscriptions_tenant_idx on public.builder_subscriptions (tenant_id, status, created_at desc);
create index if not exists builder_subscriptions_member_idx on public.builder_subscriptions (tenant_id, member_id);

create table if not exists public.builder_subscription_charges (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  subscription_id uuid not null references public.builder_subscriptions(id) on delete cascade,
  period_index integer not null check (period_index between 1 and 99),
  amount integer not null,
  status text not null check (status in ('paid', 'failed')),
  trade_no text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (subscription_id, period_index, status)
);
create index if not exists builder_subscription_charges_sub_idx on public.builder_subscription_charges (tenant_id, subscription_id, period_index);

-- 課程權益：由訂閱開通的 enrollment
alter table public.builder_course_enrollments drop constraint if exists builder_course_enrollments_source_check;
alter table public.builder_course_enrollments add constraint builder_course_enrollments_source_check check (source in ('order', 'manual', 'free', 'subscription'));

alter table public.builder_subscription_plans enable row level security;
alter table public.builder_subscriptions enable row level security;
alter table public.builder_subscription_charges enable row level security;
revoke all on table public.builder_subscription_plans, public.builder_subscriptions, public.builder_subscription_charges from public, anon, authenticated;
revoke all on sequence public.builder_subscription_charges_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_subscription_plans, public.builder_subscriptions to service_role;
grant select, insert on table public.builder_subscription_charges to service_role;
revoke update, delete, truncate on table public.builder_subscription_charges from service_role;
grant usage on sequence public.builder_subscription_charges_id_seq to service_role;

-- 每期扣款入帳（單一交易）：插入扣款紀錄（同一期同結果只會成功一次）→ 只有真正插入的那一次才轉換訂閱狀態。
-- paid：pending／active／past_due → active，延長 current_period_end、清除寬限；cancelled／expired 不動（回傳狀態讓應用層警示）。
-- failed：active／past_due → past_due，寬限期只設一次（第一次失敗起算）。
create or replace function public.builder_record_subscription_charge(
  p_tenant uuid, p_sub uuid, p_period integer, p_amount integer, p_status text, p_trade_no text, p_raw jsonb,
  p_period_end timestamptz, p_grace_until timestamptz
) returns table (inserted boolean, sub_status text)
language plpgsql
set search_path = public
as $$
declare
  v_status text;
  v_id bigint;
begin
  if p_status not in ('paid', 'failed') then
    raise exception 'builder: invalid charge status';
  end if;
  select s.status into v_status from public.builder_subscriptions s where s.id = p_sub and s.tenant_id = p_tenant for update;
  if v_status is null then
    raise exception 'builder: subscription not found';
  end if;
  insert into public.builder_subscription_charges (tenant_id, subscription_id, period_index, amount, status, trade_no, raw)
  values (p_tenant, p_sub, p_period, p_amount, p_status, p_trade_no, p_raw)
  on conflict (subscription_id, period_index, status) do nothing
  returning id into v_id;
  if v_id is null then
    return query select false, v_status;
    return;
  end if;
  if p_status = 'paid' then
    update public.builder_subscriptions s
       set status = 'active', current_period_end = greatest(coalesce(s.current_period_end, p_period_end), p_period_end),
           grace_until = null, failed_count = 0, last_charge_at = now(), activated_at = coalesce(s.activated_at, now()), updated_at = now()
     where s.id = p_sub and s.status in ('pending', 'active', 'past_due')
    returning s.status into v_status;
  else
    update public.builder_subscriptions s
       set status = 'past_due', grace_until = coalesce(s.grace_until, p_grace_until), failed_count = s.failed_count + 1, updated_at = now()
     where s.id = p_sub and s.status in ('active', 'past_due')
    returning s.status into v_status;
  end if;
  if v_status is null then
    select s.status into v_status from public.builder_subscriptions s where s.id = p_sub;
  end if;
  return query select true, v_status;
end;
$$;

revoke all on function public.builder_record_subscription_charge(uuid, uuid, integer, integer, text, text, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.builder_record_subscription_charge(uuid, uuid, integer, integer, text, text, jsonb, timestamptz, timestamptz) to service_role;
