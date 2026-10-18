-- 第四批（events／booking／courses）獨立審查修正（2026-10-19）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 相容性：只新增欄位／表／函式，既有函式簽章不變（builder_reserve_event／builder_offer_waitlist 只改內容），舊版程式照常運作。

/* M1：個資查看紀錄只增不改（照 0016 referral_ledger 的做法） */
revoke update, delete, truncate on table public.builder_pii_access_log from service_role;

/* M2：付款／取消副作用（hook）失敗紀錄：每日 cron 與讀取訂單時補做（冪等），連續失敗警示店主 */
create table if not exists public.builder_hook_failures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  hook text not null check (hook ~ '^[a-z0-9_-]{1,40}$'),
  event text not null check (event in ('paid', 'cancelled')),
  attempts integer not null default 1,
  last_error text,
  first_failed_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  resolved_at timestamptz,
  alerted_at timestamptz,
  unique (order_id, hook, event)
);
create index if not exists builder_hook_failures_open_idx on public.builder_hook_failures (last_attempt_at) where resolved_at is null;
alter table public.builder_hook_failures enable row level security;
revoke all on table public.builder_hook_failures from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_hook_failures to service_role;

/* M5：免費報名 email 確認（確認前為 held、hold_expires_at 短效）、每 email 每場次一筆；候補也要確認 */
alter table public.builder_event_registrations add column if not exists email_norm text;
alter table public.builder_event_registrations add column if not exists hold_expires_at timestamptz;
alter table public.builder_event_registrations add column if not exists email_confirmed_at timestamptz;
create index if not exists builder_event_registrations_email_idx on public.builder_event_registrations (session_id, email_norm) where email_norm is not null;
alter table public.builder_event_waitlist add column if not exists confirm_expires_at timestamptz;
alter table public.builder_event_waitlist drop constraint if exists builder_event_waitlist_status_check;
alter table public.builder_event_waitlist add constraint builder_event_waitlist_status_check check (status in ('unconfirmed', 'waiting', 'offered', 'claimed', 'lapsed', 'cancelled'));
drop index if exists public.builder_event_waitlist_once_idx;
create unique index if not exists builder_event_waitlist_once_idx on public.builder_event_waitlist (session_id, email_norm) where status in ('unconfirmed', 'waiting', 'offered');

-- 報名（0017 內容＋）：鎖場次後先把逾期未確認 email 的免費保留標 expired；每 email 每場次只能一筆有效報名；
-- 候補認領要求 email_norm 相符（M4，服務層已先比對，這裡是第二道）；pending_email＝免費報名待 email 確認（held＋短效）。
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
          case when v_pending then now() + make_interval(mins => greatest(5, least(coalesce((p_res->>'pending_minutes')::integer, 30), 120))) end)
  returning id into v_id;
  if v_offer.id is not null then
    update public.builder_event_waitlist set claimed_registration_id = v_id where id = v_offer.id;
  end if;
  return v_id;
end;
$$;

-- 候補遞補（0017 內容＋）：先釋放逾期未確認的免費保留；L3：票種停用或不在販售期間的候補者略過（留在 waiting），
-- 其餘依登記先後嚴格 FIFO（名額放不下就停）。
create or replace function public.builder_offer_waitlist(p_tenant uuid, p_session uuid, p_hours integer)
returns setof public.builder_event_waitlist
language plpgsql
set search_path = public
as $$
declare
  v_s public.builder_event_sessions%rowtype;
  v_event_status text;
  v_w public.builder_event_waitlist%rowtype;
  v_t public.builder_event_ticket_types%rowtype;
  v_used integer;
  v_tused integer;
  v_until timestamptz;
begin
  select * into v_s from public.builder_event_sessions where id = p_session and tenant_id = p_tenant for update;
  if not found then
    return;
  end if;
  update public.builder_event_registrations
     set status = 'expired', cancelled_at = now(), cancel_reason = 'email_unconfirmed', updated_at = now()
   where session_id = v_s.id and status = 'held' and order_id is null and hold_expires_at is not null and hold_expires_at <= now();
  update public.builder_event_waitlist set status = 'lapsed', updated_at = now()
   where session_id = v_s.id and status = 'offered' and offer_expires_at <= now();
  select status into v_event_status from public.builder_events where id = v_s.event_id;
  if v_s.status <> 'scheduled' or v_event_status <> 'published' or v_s.starts_at <= now() then
    return;
  end if;
  v_until := least(now() + make_interval(hours => greatest(1, least(p_hours, 168))), v_s.starts_at);
  for v_w in
    select * from public.builder_event_waitlist where session_id = v_s.id and status = 'waiting' order by created_at, id
  loop
    select * into v_t from public.builder_event_ticket_types where id = v_w.ticket_type_id;
    if not found or not v_t.active
       or (v_t.sales_start is not null and v_t.sales_start > now())
       or (v_t.sales_end is not null and v_t.sales_end <= now()) then
      continue;
    end if;
    select coalesce(sum(r.qty), 0)::integer into v_used
      from public.builder_event_registrations r where r.session_id = v_s.id and r.status in ('held', 'confirmed');
    v_used := v_used + v_s.offline_seats + coalesce((select sum(w.qty)::integer from public.builder_event_waitlist w
      where w.session_id = v_s.id and w.status = 'offered' and w.offer_expires_at > now()), 0);
    exit when v_used + v_w.qty > v_s.capacity;
    if v_t.quota is not null then
      select coalesce(sum(r.qty), 0)::integer into v_tused
        from public.builder_event_registrations r where r.ticket_type_id = v_t.id and r.status in ('held', 'confirmed');
      v_tused := v_tused + coalesce((select sum(w.qty)::integer from public.builder_event_waitlist w
        where w.ticket_type_id = v_t.id and w.status = 'offered' and w.offer_expires_at > now()), 0);
      exit when v_tused + v_w.qty > v_t.quota;
    end if;
    update public.builder_event_waitlist
       set status = 'offered', offered_at = now(), offer_expires_at = v_until, updated_at = now()
     where id = v_w.id
    returning * into v_w;
    return next v_w;
  end loop;
  return;
end;
$$;

/* M3：sandbox 付款成功 → 同一交易標記 paid（payment_sandbox）並釋放這張訂單的報名／預約保留（測試付款不佔名額） */
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
  return next v_o;
end;
$$;

/* L5：首單判斷用正規化 email（與 lib/email-normalize.ts 同規則：小寫、去 +tag、gmail 去點、googlemail→gmail） */
create or replace function public.builder_norm_email(p text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_e text := lower(btrim(coalesce(p, '')));
  v_at integer;
  v_local text;
  v_domain text;
begin
  v_at := length(v_e) - position('@' in reverse(v_e)) + 1;
  if position('@' in v_e) = 0 or v_at <= 1 then
    return v_e;
  end if;
  v_local := substr(v_e, 1, v_at - 1);
  v_domain := substr(v_e, v_at + 1);
  if position('+' in v_local) > 1 then
    v_local := substr(v_local, 1, position('+' in v_local) - 1);
  end if;
  if v_domain = 'googlemail.com' then
    v_domain := 'gmail.com';
  end if;
  if v_domain = 'gmail.com' then
    v_local := replace(v_local, '.', '');
  end if;
  return v_local || '@' || v_domain;
end;
$$;

create or replace function public.builder_count_paid_orders_for(p_tenant uuid, p_email_norm text, p_member uuid, p_exclude uuid)
returns integer
language sql
stable
set search_path = public
as $$
  select count(*)::integer from public.builder_orders o
   where o.tenant_id = p_tenant and o.status in ('paid', 'fulfilled') and o.id <> p_exclude
     and (public.builder_norm_email(o.contact->>'email') = p_email_norm or (p_member is not null and o.member_id = p_member));
$$;

revoke all on function public.builder_reserve_event(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_offer_waitlist(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.builder_mark_paid_sandbox(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.builder_norm_email(text) from public, anon, authenticated;
revoke all on function public.builder_count_paid_orders_for(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_reserve_event(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_offer_waitlist(uuid, uuid, integer) to service_role;
grant execute on function public.builder_mark_paid_sandbox(uuid, uuid, timestamptz) to service_role;
grant execute on function public.builder_norm_email(text) to service_role;
grant execute on function public.builder_count_paid_orders_for(uuid, text, uuid, uuid) to service_role;
