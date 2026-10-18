-- 第七批獨立審查（第二輪，2026-10-19）修正。
-- 🔴 共用專案：builder_ 前綴；函式固定 search_path；只 grant 給 service_role。既有函式簽章不變。

-- ================================================================ H1／H2：短網址 callback（藍新 MPG URL ≤ 200、定期定額 ≤ 100 字）
-- 短碼＝付款／訂閱上的隨機值（18 字英數），網址 /p/n/<碼>、/p/r/<碼>…；tenant／付款由短碼在 server 端查回。
alter table public.builder_payments add column if not exists short_code text;
-- 導回訂單頁要用的訂單存取金鑰（secretbox 加密、AAD 綁租戶；DB 仍只存 sha256 的 access_key_hash 供驗證）
alter table public.builder_payments add column if not exists return_key_enc text;
create unique index if not exists builder_payments_short_code_uniq on public.builder_payments (short_code) where short_code is not null;
alter table public.builder_subscriptions add column if not exists short_code text;
create unique index if not exists builder_subscriptions_short_code_uniq on public.builder_subscriptions (short_code) where short_code is not null;

-- ================================================================ M1：退款後付款狀態 refunded；已出貨訂單退款標記
alter table public.builder_payments drop constraint if exists builder_payments_status_check;
alter table public.builder_payments add constraint builder_payments_status_check
  check (status in ('pending', 'paid', 'failed', 'paid_after_cancel', 'refunded'));
alter table public.builder_orders add column if not exists refunded_at timestamptz;

-- 已出貨訂單退款成功：標記 refunded_at（只成功一次）＋同交易退回點數折抵／儲值金（ref 冪等）。庫存不回補（貨已寄出）。
create or replace function public.builder_mark_order_refunded(p_tenant uuid, p_order uuid)
returns setof public.builder_orders
language plpgsql
set search_path = public
as $$
declare
  v_o public.builder_orders%rowtype;
begin
  update public.builder_orders
     set refunded_at = now(), updated_at = now()
   where id = p_order and tenant_id = p_tenant and status = 'fulfilled' and refunded_at is null
  returning * into v_o;
  if v_o.id is null then
    return;
  end if;
  perform public.builder_release_order_credits(p_tenant, p_order);
  return next v_o;
end;
$$;
revoke all on function public.builder_mark_order_refunded(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_mark_order_refunded(uuid, uuid) to service_role;

-- 等級消費不計已退款的訂單（簽章不變）
create or replace function public.builder_member_spend(p_tenant uuid, p_member uuid, p_since timestamptz)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(greatest(0, subtotal - discount_total - tier_discount - points_discount)), 0)::bigint
    from public.builder_orders
   where tenant_id = p_tenant and member_id = p_member
     and status in ('paid', 'fulfilled') and not payment_sandbox and refunded_at is null
     and (p_since is null or paid_at >= p_since)
     and not (items @> '[{"item_kind":"topup"}]'::jsonb);
$$;

-- ================================================================ H3：委託結束後仍被扣款的期別記為 paid_after_end（不恢復訂閱、不開權益）
alter table public.builder_subscription_charges drop constraint if exists builder_subscription_charges_status_check;
alter table public.builder_subscription_charges add constraint builder_subscription_charges_status_check
  check (status in ('paid', 'failed', 'paid_after_end'));

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
  if p_status not in ('paid', 'failed', 'paid_after_end') then
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
  elsif p_status = 'failed' and not exists (
    select 1 from public.builder_subscription_charges c
     where c.subscription_id = p_sub and c.status = 'paid' and c.period_index >= p_period
  ) then
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

-- ================================================================ L4：手動調整每日上限改原子（以金額累計，條件式；併發也不會超過）
create or replace function public.builder_quota_take(p_bucket text, p_key text, p_window_start timestamptz, p_amount integer, p_limit integer)
returns table (total integer, allowed boolean)
language plpgsql
set search_path = public
as $$
declare
  v_total integer;
begin
  if p_amount < 0 or p_amount > p_limit then
    select coalesce((select rl.count from public.builder_rate_limits rl where rl.bucket = p_bucket and rl.key = p_key and rl.window_start = p_window_start), 0) into v_total;
    return query select v_total, false;
    return;
  end if;
  insert into public.builder_rate_limits as rl (bucket, key, window_start, count)
    values (p_bucket, p_key, p_window_start, p_amount)
    on conflict (bucket, key, window_start) do update set count = rl.count + p_amount
      where rl.count + p_amount <= p_limit
    returning rl.count into v_total;
  if v_total is null then
    select rl.count into v_total from public.builder_rate_limits rl where rl.bucket = p_bucket and rl.key = p_key and rl.window_start = p_window_start;
    return query select v_total, false;
    return;
  end if;
  return query select v_total, true;
end;
$$;
revoke all on function public.builder_quota_take(text, text, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.builder_quota_take(text, text, timestamptz, integer, integer) to service_role;
