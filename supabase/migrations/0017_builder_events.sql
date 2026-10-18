-- 第四批：events（活動報名）＋三個「課程類」模組共用的訂單擴充。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 相容性：builder_place_order 不動；builder_cancel_order 簽章不變（只在函式內多回收報名名額），舊版程式照常運作。
--
-- 名額設計（記取快樂手 seats_taken 假資料、beunion registered_count 含線下人數的教訓）：
--   沒有「已報名人數」計數欄位——名額一律由報名列（held／confirmed）＋有效候補保留＋店主手動保留的 offline_seats 即時加總，
--   並在同一交易內 `select … for update` 鎖住場次列，所以併發搶最後一席只會有一筆成功。

/* ------------------------------------------------------------------ 訂單品項擴充 */
alter table public.builder_order_items add column if not exists item_kind text not null default 'product';
alter table public.builder_order_items drop constraint if exists builder_order_items_item_kind_check;
alter table public.builder_order_items add constraint builder_order_items_item_kind_check check (item_kind in ('product', 'event_ticket', 'booking', 'course'));
-- event_ticket → 票種 id；booking → 服務 id；course → 課程 id
alter table public.builder_order_items add column if not exists ref_id uuid;

/* ------------------------------------------------------------------ 活動 */
create table if not exists public.builder_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  title text not null check (char_length(title) between 1 and 160),
  summary text,
  body_md text not null default '',
  cover_url text,
  location_type text not null default 'physical' check (location_type in ('physical', 'online', 'hybrid')),
  location text,
  -- 線上活動連結：只寄給已確認的報名者，不顯示在公開頁
  online_url text,
  status text not null default 'draft' check (status in ('draft', 'published', 'cancelled')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table if not exists public.builder_event_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  event_id uuid not null references public.builder_events(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Asia/Taipei',
  capacity integer not null check (capacity between 1 and 100000),
  -- 店主手動保留／線下已售的座位（明確欄位、計入名額；不會被重算覆蓋）
  offline_seats integer not null default 0 check (offline_seats >= 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists builder_event_sessions_event_idx on public.builder_event_sessions (event_id, starts_at);
create index if not exists builder_event_sessions_start_idx on public.builder_event_sessions (starts_at) where status = 'scheduled';

create table if not exists public.builder_event_ticket_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  event_id uuid not null references public.builder_events(id) on delete cascade,
  session_id uuid not null references public.builder_event_sessions(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- 0 = 免費票
  price integer not null check (price between 0 and 1000000),
  max_per_order integer not null default 4 check (max_per_order between 1 and 20),
  sales_start timestamptz,
  sales_end timestamptz,
  -- 票種配額（可選，null = 只受場次容量限制）
  quota integer check (quota is null or quota > 0),
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (sales_end is null or sales_start is null or sales_end > sales_start)
);
create index if not exists builder_event_ticket_types_session_idx on public.builder_event_ticket_types (session_id, sort);

create table if not exists public.builder_event_registrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  event_id uuid not null references public.builder_events(id) on delete cascade,
  session_id uuid not null references public.builder_event_sessions(id) on delete cascade,
  ticket_type_id uuid not null references public.builder_event_ticket_types(id) on delete cascade,
  -- 付費票：掛在訂單上（held＝付款前保留，訂單逾期／取消時同一交易釋放）
  order_id uuid references public.builder_orders(id) on delete set null,
  member_id uuid references public.builder_members(id) on delete set null,
  qty integer not null check (qty between 1 and 20),
  unit_price integer not null check (unit_price >= 0),
  contact jsonb not null,
  status text not null check (status in ('held', 'confirmed', 'cancelled', 'expired')),
  source text not null default 'online' check (source in ('online', 'waitlist')),
  -- 簽到碼＝HMAC(秘密, 報名 id) 的 sha256（原文可由伺服器重算，DB 不存原文）
  checkin_code_hash text,
  checked_in_at timestamptz,
  checked_in_by text,
  reminder_sent_at timestamptz,
  refund_required boolean not null default false,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_event_registrations_session_idx on public.builder_event_registrations (session_id, status);
create index if not exists builder_event_registrations_order_idx on public.builder_event_registrations (order_id);
create index if not exists builder_event_registrations_member_idx on public.builder_event_registrations (member_id);
create unique index if not exists builder_event_registrations_checkin_idx on public.builder_event_registrations (checkin_code_hash) where checkin_code_hash is not null;

create table if not exists public.builder_event_waitlist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  session_id uuid not null references public.builder_event_sessions(id) on delete cascade,
  ticket_type_id uuid not null references public.builder_event_ticket_types(id) on delete cascade,
  member_id uuid references public.builder_members(id) on delete set null,
  contact jsonb not null,
  -- 正規化 email（同一人同一場只能排一次）
  email_norm text not null,
  qty integer not null default 1 check (qty between 1 and 20),
  status text not null default 'waiting' check (status in ('waiting', 'offered', 'claimed', 'lapsed', 'cancelled')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  claimed_registration_id uuid references public.builder_event_registrations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_event_waitlist_session_idx on public.builder_event_waitlist (session_id, status, created_at);
create unique index if not exists builder_event_waitlist_once_idx on public.builder_event_waitlist (session_id, email_norm) where status in ('waiting', 'offered');

-- 個資查看紀錄（只增不改）：後台／MCP 查看完整聯絡資料、匯出名單都記 who/when
create table if not exists public.builder_pii_access_log (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  actor text not null,
  action text not null check (action in ('reveal', 'export')),
  subject_type text not null,
  subject_id uuid,
  detail jsonb,
  at timestamptz not null default now()
);
create index if not exists builder_pii_access_log_tenant_idx on public.builder_pii_access_log (tenant_id, at desc);

alter table public.builder_events enable row level security;
alter table public.builder_event_sessions enable row level security;
alter table public.builder_event_ticket_types enable row level security;
alter table public.builder_event_registrations enable row level security;
alter table public.builder_event_waitlist enable row level security;
alter table public.builder_pii_access_log enable row level security;
revoke all on table public.builder_events, public.builder_event_sessions, public.builder_event_ticket_types, public.builder_event_registrations,
  public.builder_event_waitlist, public.builder_pii_access_log from public, anon, authenticated;
revoke all on sequence public.builder_pii_access_log_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_events, public.builder_event_sessions, public.builder_event_ticket_types,
  public.builder_event_registrations, public.builder_event_waitlist to service_role;
grant select, insert on table public.builder_pii_access_log to service_role;
grant usage on sequence public.builder_pii_access_log_id_seq to service_role;

/* ------------------------------------------------------------------ 報名（原子扣名額） */

-- 鎖住場次列 → 檢查場次／票種／販售期間／每單上限／票價 → 用「報名列＋有效候補保留＋offline_seats」即時加總判斷容量與票種配額 → 寫入。
-- p_order = null：免費票（直接 confirmed）；否則為付費票的付款前保留（held），掛在同一交易建立的訂單上。
create or replace function public.builder_reserve_event(p_tenant uuid, p_order uuid, p_res jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_session uuid := (p_res->>'session_id')::uuid;
  v_ticket uuid := (p_res->>'ticket_type_id')::uuid;
  v_qty integer := (p_res->>'qty')::integer;
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

  -- 候補遞補：認領自己的保留（必須仍有效、同場次同票種），認領後這份保留不再佔名額
  if nullif(p_res->>'offer_id', '') is not null then
    update public.builder_event_waitlist w
       set status = 'claimed', updated_at = now()
     where w.id = (p_res->>'offer_id')::uuid and w.tenant_id = p_tenant and w.session_id = v_s.id
       and w.ticket_type_id = v_t.id and w.status = 'offered' and w.offer_expires_at > now()
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

  insert into public.builder_event_registrations (tenant_id, event_id, session_id, ticket_type_id, order_id, member_id, qty, unit_price, contact, status, source, checkin_code_hash)
  values (p_tenant, v_s.event_id, v_s.id, v_t.id, p_order, nullif(p_res->>'member_id', '')::uuid, v_qty, v_t.price, p_res->'contact',
          case when p_order is null then 'confirmed' else 'held' end,
          case when v_offer.id is not null then 'waitlist' else 'online' end,
          nullif(p_res->>'checkin_code_hash', ''))
  returning id into v_id;
  if v_offer.id is not null then
    update public.builder_event_waitlist set claimed_registration_id = v_id where id = v_offer.id;
  end if;
  return v_id;
end;
$$;

-- 預留分派（booking 模組的 migration 會擴充）
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
  raise exception 'builder: unknown reservation kind';
end;
$$;

-- 課程類訂單（活動票／預約／課程）：與 builder_place_order 同一套編號、訂單欄位、優惠券原子扣用，
-- 但品項沒有商品庫存，改成同一交易內做「名額預留」（p_res）。任一步失敗整筆回滾。
-- 🔴 優惠券區塊與 builder_place_order（0010）相同，兩邊要一起維護。
create or replace function public.builder_place_class_order(p_tenant uuid, p_order jsonb, p_items jsonb, p_day text, p_res jsonb)
returns table (order_id uuid, order_no text, reservation_id uuid)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_n integer;
  v_no text;
  v_id uuid;
  v_res uuid;
  v_cid uuid;
  v_key text;
  v_limit integer;
  v_cnt integer;
  v_found boolean;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'builder: empty order';
  end if;
  insert into public.builder_order_counters as c (tenant_id, day, last)
    values (p_tenant, p_day, 1)
    on conflict (tenant_id, day) do update set last = c.last + 1
    returning c.last into v_n;
  v_no := (p_order->>'order_prefix') || '-' || p_day || '-' ||
          case when v_n < 10000 then lpad(v_n::text, 4, '0') else v_n::text end;

  insert into public.builder_orders (
    tenant_id, order_no, member_id, contact, shipping, items, subtotal, shipping_fee, total,
    status, payment_method, expires_at, access_key_hash, note,
    discount_total, coupon_id, coupon_code, referral_code, invoice_request, shipping_choice, shipping_method
  ) values (
    p_tenant, v_no, nullif(p_order->>'member_id', '')::uuid, p_order->'contact', p_order->'shipping', p_items,
    (p_order->>'subtotal')::integer, 0, (p_order->>'total')::integer,
    'pending_payment', p_order->>'payment_method', (p_order->>'expires_at')::timestamptz,
    p_order->>'access_key_hash', p_order->>'note',
    coalesce((p_order->>'discount_total')::integer, 0),
    nullif(p_order->'coupon'->>'id', '')::uuid, p_order->'coupon'->>'code', nullif(p_order->>'referral_code', ''),
    case when jsonb_typeof(p_order->'invoice_request') = 'object' then p_order->'invoice_request' end,
    null, null
  ) returning id into v_id;

  insert into public.builder_order_items (tenant_id, order_id, product_id, variant_id, name, variant_label, sku, unit_price, qty, line_total, stock_deducted, deducted_from, item_kind, ref_id)
  select p_tenant, v_id, null, null, e.value->>'name', e.value->>'variant_label', e.value->>'sku', (e.value->>'unit_price')::integer, (e.value->>'qty')::integer,
         (e.value->>'line_total')::integer, false, null, e.value->>'item_kind', nullif(e.value->>'ref_id', '')::uuid
    from jsonb_array_elements(p_items) e;

  if jsonb_typeof(p_order->'coupon') = 'object' then
    v_cid := (p_order->'coupon'->>'id')::uuid;
    v_key := p_order->'coupon'->>'user_key';
    if v_key is null or v_key = '' then
      raise exception 'builder: coupon user key missing';
    end if;
    v_limit := null;
    update public.builder_coupons c
       set used_count = c.used_count + 1, updated_at = now()
     where c.id = v_cid and c.tenant_id = p_tenant and c.active
       and (c.starts_at is null or c.starts_at <= now())
       and (c.ends_at is null or c.ends_at > now())
       and (c.max_uses is null or c.used_count < c.max_uses)
       and (p_order->>'subtotal')::integer >= c.min_subtotal
    returning c.per_user_limit, true into v_limit, v_found;
    if v_found is null then
      raise exception 'builder: coupon unavailable';
    end if;
    v_cnt := null;
    insert into public.builder_coupon_user_counts as u (coupon_id, user_key, count)
      values (v_cid, v_key, 1)
      on conflict (coupon_id, user_key) do update set count = u.count + 1
        where v_limit is null or u.count < v_limit
      returning u.count into v_cnt;
    if v_cnt is null then
      raise exception 'builder: coupon per-user limit';
    end if;
    insert into public.builder_coupon_redemptions (tenant_id, coupon_id, order_id, user_key, amount)
      values (p_tenant, v_cid, v_id, v_key, coalesce((p_order->>'discount_total')::integer, 0));
  end if;

  v_res := public.builder_reserve_for_order(p_tenant, v_id, p_res);
  return query select v_id, v_no, v_res;
end;
$$;

-- 訂單取消／逾期時釋放掛在訂單上的名額（冪等：只動 held／confirmed）。booking 模組的 migration 會擴充。
create or replace function public.builder_release_order_reservations(p_tenant uuid, p_order uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_reason text;
  v_n integer;
begin
  select cancel_reason into v_reason from public.builder_orders where id = p_order and tenant_id = p_tenant;
  update public.builder_event_registrations
     set status = case when v_reason = 'expired' then 'expired' else 'cancelled' end,
         cancelled_at = now(), cancel_reason = coalesce(v_reason, 'order_cancelled'), updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 取消：條件式轉換＋同一交易回補庫存、優惠券、名額（簽章不變）
create or replace function public.builder_cancel_order(p_tenant uuid, p_order uuid, p_from text[], p_reason text)
returns table (transitioned boolean, stock_released boolean)
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
  v_stock boolean;
begin
  update public.builder_orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, updated_at = now()
   where id = p_order and tenant_id = p_tenant and status = any(p_from);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return query select false, false;
    return;
  end if;
  v_stock := public.builder_release_order_stock(p_tenant, p_order);
  perform public.builder_release_coupon(p_tenant, p_order);
  perform public.builder_release_order_reservations(p_tenant, p_order);
  return query select true, v_stock;
end;
$$;

-- 候補遞補：鎖住場次 → 過期的保留標 lapsed → 依登記先後（嚴格 FIFO，前一位放不下就停）把空出來的名額保留給候補者 p_hours 小時
-- （不超過開場時間）。同一份空位不會給兩個人（保留本身就佔名額），重複呼叫冪等。回傳這次新給出的保留。
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
  update public.builder_event_waitlist set status = 'lapsed', updated_at = now()
   where session_id = v_s.id and status = 'offered' and offer_expires_at <= now();
  select status into v_event_status from public.builder_events where id = v_s.event_id;
  if v_s.status <> 'scheduled' or v_event_status <> 'published' or v_s.starts_at <= now() then
    return;
  end if;
  v_until := least(now() + make_interval(hours => greatest(1, least(p_hours, 168))), v_s.starts_at);
  loop
    select * into v_w from public.builder_event_waitlist
     where session_id = v_s.id and status = 'waiting' order by created_at, id limit 1;
    exit when v_w.id is null;
    select coalesce(sum(r.qty), 0)::integer into v_used
      from public.builder_event_registrations r where r.session_id = v_s.id and r.status in ('held', 'confirmed');
    v_used := v_used + v_s.offline_seats + coalesce((select sum(w.qty)::integer from public.builder_event_waitlist w
      where w.session_id = v_s.id and w.status = 'offered' and w.offer_expires_at > now()), 0);
    exit when v_used + v_w.qty > v_s.capacity;
    select * into v_t from public.builder_event_ticket_types where id = v_w.ticket_type_id;
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

revoke all on function public.builder_reserve_event(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_reserve_for_order(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_place_class_order(uuid, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.builder_release_order_reservations(uuid, uuid) from public, anon, authenticated;
revoke all on function public.builder_cancel_order(uuid, uuid, text[], text) from public, anon, authenticated;
revoke all on function public.builder_offer_waitlist(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.builder_reserve_event(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_reserve_for_order(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_place_class_order(uuid, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.builder_release_order_reservations(uuid, uuid) to service_role;
grant execute on function public.builder_cancel_order(uuid, uuid, text[], text) to service_role;
grant execute on function public.builder_offer_waitlist(uuid, uuid, integer) to service_role;
