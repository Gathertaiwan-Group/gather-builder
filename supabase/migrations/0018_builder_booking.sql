-- 第四批：booking（時段預約）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 不需要任何 extension：時段重疊用內建 tstzrange 的 && 判斷，並在交易內鎖住服務提供者列（同一人同一時間只會有一筆成功）；
-- 另加 (provider_id, starts_at) 的 partial unique index 當第二道防線。
-- 相容性：只擴充 builder_reserve_for_order／builder_release_order_reservations 的內容（簽章不變）。

create table if not exists public.builder_booking_providers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  email text,
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_booking_providers_tenant_idx on public.builder_booking_providers (tenant_id, sort);

create table if not exists public.builder_booking_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 120),
  description_md text not null default '',
  duration_min integer not null check (duration_min between 5 and 720),
  -- 每筆預約之後的緩衝時間（整理場地、休息），不讓下一位緊接著約
  buffer_min integer not null default 0 check (buffer_min between 0 and 240),
  price integer not null default 0 check (price between 0 and 1000000),
  -- none：不線上收費（現場付）；deposit：線上收訂金；full：線上收全額
  payment_mode text not null default 'none' check (payment_mode in ('none', 'deposit', 'full')),
  deposit_amount integer check (deposit_amount is null or deposit_amount > 0),
  status text not null default 'draft' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug),
  check (payment_mode <> 'deposit' or (deposit_amount is not null and deposit_amount <= price))
);

-- 每週可預約時段（台北時間，從當天 00:00 起算的分鐘數）
create table if not exists public.builder_booking_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  provider_id uuid not null references public.builder_booking_providers(id) on delete cascade,
  weekday integer not null check (weekday between 0 and 6),
  start_min integer not null check (start_min between 0 and 1439),
  end_min integer not null check (end_min between 1 and 1440),
  check (end_min > start_min)
);
create index if not exists builder_booking_hours_provider_idx on public.builder_booking_hours (provider_id, weekday);

-- 例外日：closed＝整天休假（蓋掉每週時段）；open＝加開時段（可與 closed 同日 → 只開加開的時段）
create table if not exists public.builder_booking_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  provider_id uuid not null references public.builder_booking_providers(id) on delete cascade,
  date text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  kind text not null check (kind in ('closed', 'open')),
  start_min integer check (start_min is null or start_min between 0 and 1439),
  end_min integer check (end_min is null or end_min between 1 and 1440),
  note text,
  created_at timestamptz not null default now(),
  check (kind = 'closed' or (start_min is not null and end_min is not null and end_min > start_min))
);
create index if not exists builder_booking_overrides_idx on public.builder_booking_overrides (provider_id, date);

create table if not exists public.builder_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  provider_id uuid not null references public.builder_booking_providers(id) on delete cascade,
  service_id uuid not null references public.builder_booking_services(id) on delete cascade,
  order_id uuid references public.builder_orders(id) on delete set null,
  member_id uuid references public.builder_members(id) on delete set null,
  contact jsonb not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- ends_at＋緩衝：這段時間內提供者不能再被預約
  block_until timestamptz not null,
  status text not null check (status in ('held', 'confirmed', 'cancelled', 'expired')),
  price integer not null check (price >= 0),
  amount_due integer not null default 0 check (amount_due >= 0),
  note text,
  reminder_sent_at timestamptz,
  refund_required boolean not null default false,
  cancelled_at timestamptz,
  cancel_reason text,
  cancelled_by text,
  rescheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and block_until >= ends_at)
);
create index if not exists builder_bookings_provider_idx on public.builder_bookings (provider_id, starts_at) where status in ('held', 'confirmed');
create index if not exists builder_bookings_tenant_idx on public.builder_bookings (tenant_id, starts_at);
create index if not exists builder_bookings_order_idx on public.builder_bookings (order_id);
-- 第二道防線：同一提供者同一開始時間只能有一筆有效預約
create unique index if not exists builder_bookings_slot_once_idx on public.builder_bookings (provider_id, starts_at) where status in ('held', 'confirmed');

alter table public.builder_booking_providers enable row level security;
alter table public.builder_booking_services enable row level security;
alter table public.builder_booking_hours enable row level security;
alter table public.builder_booking_overrides enable row level security;
alter table public.builder_bookings enable row level security;
revoke all on table public.builder_booking_providers, public.builder_booking_services, public.builder_booking_hours, public.builder_booking_overrides, public.builder_bookings
  from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_booking_providers, public.builder_booking_services, public.builder_booking_hours,
  public.builder_booking_overrides, public.builder_bookings to service_role;

/* ------------------------------------------------------------------ 預約（原子防重複） */

-- 鎖住提供者列 → 確認服務已上架、提供者啟用 → 用 tstzrange 判斷 [starts_at, block_until) 與既有有效預約是否重疊 → 寫入。
-- 「是否落在營業時間內」由應用層純函式（lib/booking/availability.ts）檢查；這裡只負責「同時段只能一筆」。
create or replace function public.builder_reserve_booking(p_tenant uuid, p_order uuid, p_res jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_provider uuid := (p_res->>'provider_id')::uuid;
  v_start timestamptz := (p_res->>'starts_at')::timestamptz;
  v_end timestamptz := (p_res->>'ends_at')::timestamptz;
  v_block timestamptz := (p_res->>'block_until')::timestamptz;
  v_active boolean;
  v_status text;
  v_id uuid;
begin
  select active into v_active from public.builder_booking_providers where id = v_provider and tenant_id = p_tenant for update;
  if v_active is null or not v_active then
    raise exception 'builder: provider unavailable';
  end if;
  select status into v_status from public.builder_booking_services where id = (p_res->>'service_id')::uuid and tenant_id = p_tenant;
  if v_status is distinct from 'published' then
    raise exception 'builder: service unavailable';
  end if;
  if v_start <= now() then
    raise exception 'builder: slot taken';
  end if;
  if exists (
    select 1 from public.builder_bookings b
     where b.provider_id = v_provider and b.status in ('held', 'confirmed')
       and tstzrange(b.starts_at, b.block_until, '[)') && tstzrange(v_start, v_block, '[)')
  ) then
    raise exception 'builder: slot taken';
  end if;
  insert into public.builder_bookings (tenant_id, provider_id, service_id, order_id, member_id, contact, starts_at, ends_at, block_until, status, price, amount_due, note)
  values (p_tenant, v_provider, (p_res->>'service_id')::uuid, p_order, nullif(p_res->>'member_id', '')::uuid, p_res->'contact', v_start, v_end, v_block,
          case when p_order is null then 'confirmed' else 'held' end,
          (p_res->>'price')::integer, coalesce((p_res->>'amount_due')::integer, 0), nullif(p_res->>'note', ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- 改期：同樣鎖提供者、排除自己後判斷重疊
create or replace function public.builder_reschedule_booking(p_tenant uuid, p_booking uuid, p_start timestamptz, p_end timestamptz, p_block timestamptz)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_b public.builder_bookings%rowtype;
begin
  select * into v_b from public.builder_bookings where id = p_booking and tenant_id = p_tenant;
  if not found then
    raise exception 'builder: booking not found';
  end if;
  perform 1 from public.builder_booking_providers where id = v_b.provider_id for update;
  select * into v_b from public.builder_bookings where id = p_booking;
  if v_b.status not in ('held', 'confirmed') then
    return false;
  end if;
  if p_start <= now() then
    raise exception 'builder: slot taken';
  end if;
  if exists (
    select 1 from public.builder_bookings b
     where b.provider_id = v_b.provider_id and b.id <> v_b.id and b.status in ('held', 'confirmed')
       and tstzrange(b.starts_at, b.block_until, '[)') && tstzrange(p_start, p_block, '[)')
  ) then
    raise exception 'builder: slot taken';
  end if;
  update public.builder_bookings
     set starts_at = p_start, ends_at = p_end, block_until = p_block, reminder_sent_at = null, rescheduled_at = now(), updated_at = now()
   where id = v_b.id;
  return true;
end;
$$;

create or replace function public.builder_reserve_for_order(p_tenant uuid, p_order uuid, p_res jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
begin
  if p_res is null or jsonb_typeof(p_res) <> 'object' then
    return null;
  end if;
  if p_res->>'kind' = 'event' then
    return public.builder_reserve_event(p_tenant, p_order, p_res->'data');
  end if;
  if p_res->>'kind' = 'booking' then
    return public.builder_reserve_booking(p_tenant, p_order, p_res->'data');
  end if;
  raise exception 'builder: unknown reservation kind';
end;
$$;

create or replace function public.builder_release_order_reservations(p_tenant uuid, p_order uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_reason text;
  v_n integer;
  v_m integer;
begin
  select cancel_reason into v_reason from public.builder_orders where id = p_order and tenant_id = p_tenant;
  update public.builder_event_registrations
     set status = case when v_reason = 'expired' then 'expired' else 'cancelled' end,
         cancelled_at = now(), cancel_reason = coalesce(v_reason, 'order_cancelled'), updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  get diagnostics v_n = row_count;
  update public.builder_bookings
     set status = case when v_reason = 'expired' then 'expired' else 'cancelled' end,
         cancelled_at = now(), cancel_reason = coalesce(v_reason, 'order_cancelled'), cancelled_by = 'order', updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  get diagnostics v_m = row_count;
  return v_n + v_m;
end;
$$;

revoke all on function public.builder_reserve_booking(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_reschedule_booking(uuid, uuid, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.builder_reserve_for_order(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_release_order_reservations(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_reserve_booking(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_reschedule_booking(uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.builder_reserve_for_order(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_release_order_reservations(uuid, uuid) to service_role;
