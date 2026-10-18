-- 第三批模組的訂單擴充＋優惠券（coupons）。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。
-- builder_place_order／builder_cancel_order 簽章不變（只改函式內容；舊版程式不送新欄位 → 新欄位為預設值），不需相容層。

alter table public.builder_orders add column if not exists discount_total integer not null default 0 check (discount_total >= 0);
alter table public.builder_orders add column if not exists coupon_id uuid;
alter table public.builder_orders add column if not exists coupon_code text;
alter table public.builder_orders add column if not exists referral_code text;
-- 發票需求（載具／捐贈／三聯式），結帳時寫入
alter table public.builder_orders add column if not exists invoice_request jsonb;
-- 運送方式選擇（methodId、類型、超商門市…），結帳時由 server 依店家設定寫入
alter table public.builder_orders add column if not exists shipping_choice jsonb;

create table if not exists public.builder_coupons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{3,32}$'),
  kind text not null check (kind in ('fixed', 'percent')),
  -- fixed：折抵金額（NT$）；percent：折扣百分比 1–100
  value integer not null check (value > 0 and value <= 10000000),
  -- 百分比券一定要有折抵上限
  max_discount integer check (max_discount is null or max_discount > 0),
  min_subtotal integer not null default 0 check (min_subtotal >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  per_user_limit integer check (per_user_limit is null or per_user_limit > 0),
  -- 只限某會員使用（推薦回饋券）
  assigned_member_id uuid references public.builder_members(id) on delete cascade,
  active boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'referral')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  check (kind <> 'percent' or (value between 1 and 100 and max_discount is not null)),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists public.builder_coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  coupon_id uuid not null references public.builder_coupons(id) on delete cascade,
  order_id uuid not null unique references public.builder_orders(id) on delete cascade,
  user_key text not null,
  amount integer not null check (amount >= 0),
  created_at timestamptz not null default now(),
  -- 取消／逾期回補的冪等旗標
  released_at timestamptz
);
create index if not exists builder_coupon_redemptions_coupon_idx on public.builder_coupon_redemptions (coupon_id);

-- 每人使用次數（原子計數；user_key = member:<id> 或 email:<小寫 email>）
create table if not exists public.builder_coupon_user_counts (
  coupon_id uuid not null references public.builder_coupons(id) on delete cascade,
  user_key text not null,
  count integer not null default 0 check (count >= 0),
  primary key (coupon_id, user_key)
);

alter table public.builder_coupons enable row level security;
alter table public.builder_coupon_redemptions enable row level security;
alter table public.builder_coupon_user_counts enable row level security;
revoke all on table public.builder_coupons, public.builder_coupon_redemptions, public.builder_coupon_user_counts from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_coupons, public.builder_coupon_redemptions, public.builder_coupon_user_counts to service_role;

-- 下單（沿用 0008 內容）＋新欄位＋優惠券原子扣用：
-- 總次數（used_count < max_uses）與每人次數（count < per_user_limit）都在同一交易內以條件更新扣，任一不足就 raise 整筆回滾。
create or replace function public.builder_place_order(p_tenant uuid, p_order jsonb, p_items jsonb, p_day text)
returns table (order_id uuid, order_no text)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_item jsonb;
  v_idx bigint;
  v_qty integer;
  v_track boolean;
  v_n integer;
  v_no text;
  v_id uuid;
  v_map jsonb := '{}'::jsonb;
  v_cid uuid;
  v_key text;
  v_limit integer;
  v_cnt integer;
  v_found boolean;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'builder: empty order';
  end if;
  for v_item, v_idx in
    select e.value, e.ordinality from jsonb_array_elements(p_items) with ordinality e
     order by e.value->>'product_id', coalesce(e.value->>'variant_id', '')
  loop
    v_qty := (v_item->>'qty')::integer;
    v_track := null;
    if v_item->>'variant_id' is not null then
      update public.builder_product_variants v
         set stock = case when p.track_inventory then v.stock - v_qty else v.stock end
        from public.builder_products p
       where v.id = (v_item->>'variant_id')::uuid
         and v.product_id = (v_item->>'product_id')::uuid
         and p.id = v.product_id
         and v.tenant_id = p_tenant and p.tenant_id = p_tenant
         and p.status = 'published'
         and (not p.track_inventory or v.stock >= v_qty)
      returning p.track_inventory into v_track;
    else
      update public.builder_products p
         set stock = case when p.track_inventory then p.stock - v_qty else p.stock end
       where p.id = (v_item->>'product_id')::uuid
         and p.tenant_id = p_tenant
         and p.status = 'published'
         and (not p.track_inventory or p.stock >= v_qty)
      returning p.track_inventory into v_track;
    end if;
    if v_track is null then
      raise exception 'builder: insufficient stock: %', coalesce(v_item->>'name', '?');
    end if;
    v_map := v_map || jsonb_build_object(v_idx::text, v_track);
  end loop;

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
    (p_order->>'subtotal')::integer, (p_order->>'shipping_fee')::integer, (p_order->>'total')::integer,
    'pending_payment', p_order->>'payment_method', (p_order->>'expires_at')::timestamptz,
    p_order->>'access_key_hash', p_order->>'note',
    coalesce((p_order->>'discount_total')::integer, 0),
    nullif(p_order->'coupon'->>'id', '')::uuid, p_order->'coupon'->>'code', nullif(p_order->>'referral_code', ''),
    case when jsonb_typeof(p_order->'invoice_request') = 'object' then p_order->'invoice_request' end,
    case when jsonb_typeof(p_order->'shipping_choice') = 'object' then p_order->'shipping_choice' end,
    nullif(p_order->'shipping_choice'->>'label', '')
  ) returning id into v_id;

  insert into public.builder_order_items (tenant_id, order_id, product_id, variant_id, name, variant_label, sku, unit_price, qty, line_total, stock_deducted, deducted_from)
  select p_tenant, v_id, (e.value->>'product_id')::uuid, nullif(e.value->>'variant_id', '')::uuid, e.value->>'name',
         e.value->>'variant_label', e.value->>'sku', (e.value->>'unit_price')::integer, (e.value->>'qty')::integer,
         (e.value->>'line_total')::integer, (v_map->>(e.ordinality::text))::boolean,
         case when (v_map->>(e.ordinality::text))::boolean
              then case when nullif(e.value->>'variant_id', '') is null then 'product' else 'variant' end end
    from jsonb_array_elements(p_items) with ordinality e;

  -- 優惠券：原子扣總次數＋每人次數（下單成功才算；取消時 builder_release_coupon 冪等回補）
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

  return query select v_id, v_no;
end;
$$;

-- 優惠券回補（冪等）：只有把 released_at 從 null 改掉的那一次會回補次數
create or replace function public.builder_release_coupon(p_tenant uuid, p_order uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_cid uuid;
  v_key text;
begin
  update public.builder_coupon_redemptions r set released_at = now()
   where r.order_id = p_order and r.tenant_id = p_tenant and r.released_at is null
  returning r.coupon_id, r.user_key into v_cid, v_key;
  if v_cid is null then
    return false;
  end if;
  update public.builder_coupons set used_count = greatest(used_count - 1, 0), updated_at = now() where id = v_cid;
  update public.builder_coupon_user_counts set count = greatest(count - 1, 0) where coupon_id = v_cid and user_key = v_key;
  return true;
end;
$$;

-- 取消：條件式轉換＋同一交易回補庫存與優惠券（簽章不變）
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
  return query select true, v_stock;
end;
$$;

revoke all on function public.builder_place_order(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.builder_release_coupon(uuid, uuid) from public, anon, authenticated;
revoke all on function public.builder_cancel_order(uuid, uuid, text[], text) from public, anon, authenticated;
grant execute on function public.builder_place_order(uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.builder_release_coupon(uuid, uuid) to service_role;
grant execute on function public.builder_cancel_order(uuid, uuid, text[], text) to service_role;
