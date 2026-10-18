-- 第五六批獨立審查修正（2026-10-19）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role；函式固定 search_path。
-- 簽章全部不變（只改內容），舊版程式照常可呼叫；新欄位都有預設值。

-- ================================================================ H1 帳本退回回原批次（不讓已到期點數／贈送額度復活）
-- 帳本加寫入順序（重播用）。ADD COLUMN bigserial 會依現有列的實體順序填號（≈ 寫入順序）。
alter table public.builder_points_ledger add column if not exists seq bigserial;
alter table public.builder_wallet_ledger add column if not exists seq bigserial;
create index if not exists builder_points_ledger_seq_idx on public.builder_points_ledger (tenant_id, member_id, seq);
create index if not exists builder_wallet_ledger_seq_idx on public.builder_wallet_ledger (tenant_id, member_id, seq);
revoke all on sequence public.builder_points_ledger_seq_seq, public.builder_wallet_ledger_seq_seq from public, anon, authenticated;
grant usage on sequence public.builder_points_ledger_seq_seq, public.builder_wallet_ledger_seq_seq to service_role;

-- 帳本狀態：依 seq 重播（與 lib/loyalty/ledger.ts computeLedgerState 逐行同規則）。
-- 每筆扣帳「當時」從哪些批次扣了多少是確定的（帳本只增不改＝分配明細不會被事後改寫）；
-- 退回（reverse＋／refund＋）回到原扣帳的批次：先同訂單的 redeem／spend 分配（新到舊）→ 其他 redeem／spend 分配（新到舊）→ 不到期新批次。
-- 原批次已到期 → 退回的部分屬於已到期批次（算入 expired_due，下一次寫成 expire），不會復活。
create or replace function public.builder_ledger_state(p_table text, p_tenant uuid, p_member uuid, p_now timestamptz)
returns table (balance bigint, available bigint, expired_due bigint, next_expiry timestamptz)
language plpgsql
stable
set search_path = public
as $$
declare
  r record;
  l_amount bigint[] := '{}';
  l_rem bigint[] := '{}';
  l_exp timestamptz[] := '{}';
  l_order uuid[] := '{}';
  l_seq bigint[] := '{}';
  a_order uuid[] := '{}';
  a_lot integer[] := '{}';
  a_amt bigint[] := '{}';
  v_bal bigint := 0;
  v_need bigint;
  v_give bigint;
  v_take bigint;
  v_best integer;
  v_n integer;
  i integer;
  v_pref uuid;
  v_ok boolean;
  v_better boolean;
  v_live bigint := 0;
  v_expired bigint := 0;
  v_next timestamptz := null;
  v_pass integer;
begin
  if p_table not in ('builder_points_ledger', 'builder_wallet_ledger') then
    raise exception 'builder: bad ledger';
  end if;
  for r in execute format('select kind, amount::bigint as amount, expires_at, created_at, order_id, seq from public.%I where tenant_id = $1 and member_id = $2 order by seq', p_table)
    using p_tenant, p_member
  loop
    v_bal := v_bal + r.amount;
    if r.amount > 0 and r.kind not in ('reverse', 'refund') then
      l_amount := array_append(l_amount, r.amount);
      l_rem := array_append(l_rem, r.amount);
      l_exp := array_append(l_exp, r.expires_at);
      l_order := array_append(l_order, r.order_id);
      l_seq := array_append(l_seq, r.seq);
    elsif r.amount < 0 then
      v_need := -r.amount;
      v_pref := case when r.kind = 'reverse' then r.order_id else null end;
      v_n := coalesce(array_length(l_rem, 1), 0);
      while v_need > 0 loop
        v_best := null;
        for i in 1..v_n loop
          continue when l_rem[i] <= 0;
          if r.kind = 'expire' then
            v_ok := l_exp[i] is not null and l_exp[i] <= r.created_at;
          else
            v_ok := l_exp[i] is null or l_exp[i] > r.created_at;
          end if;
          continue when not v_ok;
          if v_best is null then
            v_best := i;
          else
            v_better := false;
            if v_pref is not null and (l_order[i] is not distinct from v_pref) <> (l_order[v_best] is not distinct from v_pref) then
              v_better := l_order[i] is not distinct from v_pref;
            elsif coalesce(l_exp[i], 'infinity'::timestamptz) <> coalesce(l_exp[v_best], 'infinity'::timestamptz) then
              v_better := coalesce(l_exp[i], 'infinity'::timestamptz) < coalesce(l_exp[v_best], 'infinity'::timestamptz);
            else
              v_better := l_seq[i] < l_seq[v_best];
            end if;
            if v_better then
              v_best := i;
            end if;
          end if;
        end loop;
        exit when v_best is null;
        v_take := least(v_need, l_rem[v_best]);
        l_rem[v_best] := l_rem[v_best] - v_take;
        v_need := v_need - v_take;
        if r.kind in ('redeem', 'spend') then
          a_order := array_append(a_order, r.order_id);
          a_lot := array_append(a_lot, v_best);
          a_amt := array_append(a_amt, v_take);
        end if;
      end loop;
    else
      v_give := r.amount;
      -- pass 1：同訂單的分配；pass 2：任何分配
      for v_pass in 1..2 loop
        exit when v_give <= 0;
        continue when v_pass = 1 and r.order_id is null;
        for i in reverse coalesce(array_length(a_amt, 1), 0)..1 loop
          exit when v_give <= 0;
          continue when a_amt[i] <= 0;
          continue when v_pass = 1 and a_order[i] is distinct from r.order_id;
          v_take := least(v_give, a_amt[i]);
          a_amt[i] := a_amt[i] - v_take;
          l_rem[a_lot[i]] := l_rem[a_lot[i]] + v_take;
          v_give := v_give - v_take;
        end loop;
      end loop;
      if v_give > 0 then
        l_amount := array_append(l_amount, v_give);
        l_rem := array_append(l_rem, v_give);
        l_exp := array_append(l_exp, null::timestamptz);
        l_order := array_append(l_order, r.order_id);
        l_seq := array_append(l_seq, r.seq);
      end if;
    end if;
  end loop;
  for i in 1..coalesce(array_length(l_rem, 1), 0) loop
    if l_exp[i] is null or l_exp[i] > p_now then
      v_live := v_live + l_rem[i];
      if l_rem[i] > 0 and l_exp[i] is not null and (v_next is null or l_exp[i] < v_next) then
        v_next := l_exp[i];
      end if;
    else
      v_expired := v_expired + l_rem[i];
    end if;
  end loop;
  v_expired := greatest(0, least(v_expired, v_bal));
  return query select v_bal, greatest(0, least(v_live, v_bal - v_expired)), v_expired, v_next;
end;
$$;
revoke all on function public.builder_ledger_state(text, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.builder_ledger_state(text, uuid, uuid, timestamptz) to service_role;

-- ================================================================ M6 未確認 email 的免費保留：每筆 1 張、15 分鐘、每場次總量上限
-- builder_reserve_event 簽章不變（0020 內容＋pending 檢查；p_res 新增 pending_cap，舊版程式不帶＝不限，與舊行為相同）
create or replace function public.builder_reserve_event(p_tenant uuid, p_order uuid, p_res jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_session uuid := (p_res->>'session_id')::uuid;
  v_ticket uuid := (p_res->>'ticket_type_id')::uuid;
  v_qty integer := (p_res->>'qty')::integer;
  v_email text := nullif(p_res->>'email_norm', '');
  v_pending boolean := coalesce((p_res->>'pending_email')::boolean, false) and p_order is null;
  v_s public.builder_event_sessions%rowtype;
  v_event_status text;
  v_t public.builder_event_ticket_types%rowtype;
  v_offer public.builder_event_waitlist%rowtype;
  v_used integer;
  v_tused integer;
  v_id uuid;
  v_pending_cap integer := greatest(1, coalesce((p_res->>'pending_cap')::integer, 1000000));
  v_pending_used integer;
begin
  select * into v_s from public.builder_event_sessions where id = v_session and tenant_id = p_tenant for update;
  if not found then
    raise exception 'builder: session not found';
  end if;
  update public.builder_event_registrations
     set status = 'expired', cancelled_at = now(), cancel_reason = 'email_unconfirmed', updated_at = now()
   where session_id = v_s.id and status = 'held' and order_id is null and hold_expires_at is not null and hold_expires_at <= now();
  select status into v_event_status from public.builder_events where id = v_s.event_id;
  if v_s.status <> 'scheduled' or v_event_status <> 'published' then
    raise exception 'builder: session closed';
  end if;
  if v_s.starts_at <= now() then
    raise exception 'builder: session started';
  end if;
  select * into v_t from public.builder_event_ticket_types where id = v_ticket and session_id = v_s.id and tenant_id = p_tenant;
  if not found or not v_t.active then
    raise exception 'builder: ticket unavailable';
  end if;
  if (v_t.sales_start is not null and v_t.sales_start > now()) or (v_t.sales_end is not null and v_t.sales_end <= now()) then
    raise exception 'builder: ticket not on sale';
  end if;
  if v_qty is null or v_qty < 1 or v_qty > v_t.max_per_order then
    raise exception 'builder: qty limit';
  end if;
  if (p_res->>'unit_price')::integer is distinct from v_t.price then
    raise exception 'builder: price changed';
  end if;
  -- 審查 M6：未確認 email 的免費保留每筆只能 1 張，且每場次未確認保留總量有上限（超過 → 呼叫端改登記候補，不佔名額）
  if v_pending then
    if v_qty <> 1 then
      raise exception 'builder: pending qty';
    end if;
    select count(*)::integer into v_pending_used
      from public.builder_event_registrations r
     where r.session_id = v_s.id and r.status = 'held' and r.order_id is null and r.hold_expires_at is not null and r.hold_expires_at > now();
    if v_pending_used + 1 > v_pending_cap then
      raise exception 'builder: pending cap';
    end if;
  end if;
  if v_email is not null and exists (
    select 1 from public.builder_event_registrations r
     where r.session_id = v_s.id and r.email_norm = v_email and r.status in ('held', 'confirmed')
  ) then
    raise exception 'builder: already registered';
  end if;

  if nullif(p_res->>'offer_id', '') is not null then
    update public.builder_event_waitlist w
       set status = 'claimed', updated_at = now()
     where w.id = (p_res->>'offer_id')::uuid and w.tenant_id = p_tenant and w.session_id = v_s.id
       and w.ticket_type_id = v_t.id and w.status = 'offered' and w.offer_expires_at > now()
       and (v_email is null or w.email_norm = v_email)
    returning * into v_offer;
    if v_offer.id is null then
      raise exception 'builder: offer invalid';
    end if;
    if v_qty > v_offer.qty then
      raise exception 'builder: qty limit';
    end if;
  end if;

  select coalesce(sum(r.qty), 0)::integer into v_used
    from public.builder_event_registrations r where r.session_id = v_s.id and r.status in ('held', 'confirmed');
  v_used := v_used + v_s.offline_seats + coalesce((select sum(w.qty)::integer from public.builder_event_waitlist w
    where w.session_id = v_s.id and w.status = 'offered' and w.offer_expires_at > now()), 0);
  if v_used + v_qty > v_s.capacity then
    raise exception 'builder: sold out';
  end if;
  if v_t.quota is not null then
    select coalesce(sum(r.qty), 0)::integer into v_tused
      from public.builder_event_registrations r where r.ticket_type_id = v_t.id and r.status in ('held', 'confirmed');
    v_tused := v_tused + coalesce((select sum(w.qty)::integer from public.builder_event_waitlist w
      where w.ticket_type_id = v_t.id and w.status = 'offered' and w.offer_expires_at > now()), 0);
    if v_tused + v_qty > v_t.quota then
      raise exception 'builder: ticket sold out';
    end if;
  end if;

  insert into public.builder_event_registrations (tenant_id, event_id, session_id, ticket_type_id, order_id, member_id, qty, unit_price, contact, status, source, checkin_code_hash, email_norm, hold_expires_at)
  values (p_tenant, v_s.event_id, v_s.id, v_t.id, p_order, nullif(p_res->>'member_id', '')::uuid, v_qty, v_t.price, p_res->'contact',
          case when p_order is null and not v_pending then 'confirmed' else 'held' end,
          case when v_offer.id is not null then 'waitlist' else 'online' end,
          nullif(p_res->>'checkin_code_hash', ''), v_email,
          case when v_pending then now() + make_interval(mins => greatest(5, least(coalesce((p_res->>'pending_minutes')::integer, 15), 120))) end)
  returning id into v_id;
  if v_offer.id is not null then
    update public.builder_event_waitlist set claimed_registration_id = v_id where id = v_offer.id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.builder_reserve_event(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.builder_reserve_event(uuid, uuid, jsonb) to service_role;

-- ================================================================ L1 sandbox 付款同交易退回點數、儲值金、優惠券次數（簽章不變）
create or replace function public.builder_mark_paid_sandbox(p_tenant uuid, p_order uuid, p_paid_at timestamptz)
returns setof public.builder_orders
language plpgsql
set search_path = public
as $$
declare
  v_o public.builder_orders%rowtype;
begin
  update public.builder_orders
     set status = 'paid', paid_at = p_paid_at, payment_sandbox = true, updated_at = now()
   where id = p_order and tenant_id = p_tenant and status = 'pending_payment'
  returning * into v_o;
  if v_o.id is null then
    return;
  end if;
  update public.builder_event_registrations
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'sandbox_payment', updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  update public.builder_bookings
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'sandbox_payment', cancelled_by = 'order', updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  -- 第五六批審查 L1：測試付款同交易退回點數折抵、儲值金與優惠券次數（各自冪等：ref／released_at）
  perform public.builder_release_coupon(p_tenant, p_order);
  perform public.builder_release_order_credits(p_tenant, p_order);
  return next v_o;
end;
$$;
revoke all on function public.builder_mark_paid_sandbox(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.builder_mark_paid_sandbox(uuid, uuid, timestamptz) to service_role;
