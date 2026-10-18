-- 第七批獨立審查修正（2026-10-19）：晚到的「扣款失敗」通知不能把已扣款成功的期別降級成 past_due。
-- 🔴 共用專案：builder_ 前綴；函式固定 search_path；只 grant 給 service_role。簽章不變。
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
  elsif not exists (
    -- 晚到的失敗通知：這一期或之後的期別已經扣款成功 → 不降級
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
