-- shop 模組：商品、規格、訂單、金流憑證、付款紀錄。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。
-- 預留：builder_orders.invoice_status / shipping_method / shipping_tracking（發票、物流模組是下一批）。

create table if not exists public.builder_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 160),
  description_md text not null default '',
  images jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'published')),
  price integer not null check (price >= 0 and price <= 10000000),
  compare_at_price integer check (compare_at_price is null or compare_at_price >= 0),
  sku text,
  track_inventory boolean not null default false,
  stock integer not null default 0 check (stock >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists builder_products_tenant_idx on public.builder_products (tenant_id, status, sort);

create table if not exists public.builder_product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  product_id uuid not null references public.builder_products(id) on delete cascade,
  options jsonb not null default '{}'::jsonb,
  -- null = 沿用商品價格
  price integer check (price is null or (price >= 0 and price <= 10000000)),
  sku text,
  stock integer not null default 0 check (stock >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists builder_product_variants_product_idx on public.builder_product_variants (product_id, sort);

create table if not exists public.builder_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  order_no text not null,
  member_id uuid references public.builder_members(id) on delete set null,
  contact jsonb not null,
  shipping jsonb not null,
  -- 下單當下的品項快照（顯示用；權威明細在 builder_order_items）
  items jsonb not null,
  subtotal integer not null check (subtotal >= 0),
  shipping_fee integer not null default 0 check (shipping_fee >= 0),
  total integer not null check (total >= 0),
  status text not null default 'pending_payment' check (status in ('pending_payment', 'paid', 'fulfilled', 'cancelled')),
  payment_method text not null check (payment_method in ('pchomepay', 'offline')),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  expires_at timestamptz,
  -- 回補庫存的冪等旗標：只有把它從 null 改成 now() 的那一次會加回庫存
  stock_released_at timestamptz,
  access_key_hash text not null,
  note text,
  -- 預留給發票／物流模組
  invoice_status text,
  shipping_method text,
  shipping_tracking text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_no)
);
create index if not exists builder_orders_tenant_idx on public.builder_orders (tenant_id, created_at desc);
create index if not exists builder_orders_member_idx on public.builder_orders (member_id, created_at desc);
create index if not exists builder_orders_pending_idx on public.builder_orders (expires_at) where status = 'pending_payment';

create table if not exists public.builder_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  product_id uuid references public.builder_products(id) on delete set null,
  variant_id uuid references public.builder_product_variants(id) on delete set null,
  name text not null,
  variant_label text,
  sku text,
  unit_price integer not null check (unit_price >= 0),
  qty integer not null check (qty between 1 and 99),
  line_total integer not null check (line_total >= 0),
  -- 下單時是否真的扣了庫存（回補只補扣過的）
  stock_deducted boolean not null default false
);
create index if not exists builder_order_items_order_idx on public.builder_order_items (order_id);

create table if not exists public.builder_order_counters (
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  day text not null,
  last integer not null default 0,
  primary key (tenant_id, day)
);

create table if not exists public.builder_payment_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  provider text not null check (provider in ('pchomepay')),
  sandbox boolean not null default true,
  app_id text not null,
  -- AES-256-GCM（金鑰在 env PAYMENT_ENC_KEY），DB 裡沒有明文
  secret_enc text not null,
  status text not null default 'unverified' check (status in ('unverified', 'verified')),
  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider)
);

create table if not exists public.builder_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  provider text not null check (provider in ('pchomepay')),
  gateway_order_no text not null unique,
  amount integer not null check (amount >= 0),
  sandbox boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'paid_after_cancel')),
  payment_url text,
  raw jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_payments_order_idx on public.builder_payments (order_id);

alter table public.builder_products enable row level security;
alter table public.builder_product_variants enable row level security;
alter table public.builder_orders enable row level security;
alter table public.builder_order_items enable row level security;
alter table public.builder_order_counters enable row level security;
alter table public.builder_payment_accounts enable row level security;
alter table public.builder_payments enable row level security;

revoke all on table
  public.builder_products, public.builder_product_variants, public.builder_orders, public.builder_order_items,
  public.builder_order_counters, public.builder_payment_accounts, public.builder_payments
  from public, anon, authenticated;
grant select, insert, update, delete on table
  public.builder_products, public.builder_product_variants, public.builder_orders, public.builder_order_items,
  public.builder_order_counters, public.builder_payment_accounts, public.builder_payments
  to service_role;

-- 下單：單一交易內原子扣庫存（stock >= qty 條件）＋遞增訂單編號＋寫入訂單與明細。
-- 任一品項不足 → raise，整筆回滾。價格由應用層依 DB 重新計算後傳入（不信任前端）。
-- p_items: [{ product_id, variant_id|null, name, variant_label, sku, unit_price, qty, line_total }]
create or replace function public.builder_place_order(p_tenant uuid, p_order jsonb, p_items jsonb, p_day text)
returns table (order_id uuid, order_no text)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_item jsonb;
  v_qty integer;
  v_track boolean;
  v_n integer;
  v_no text;
  v_id uuid;
  v_deducted jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'builder: empty order';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
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
    v_deducted := v_deducted || jsonb_build_array(v_track);
  end loop;

  insert into public.builder_order_counters as c (tenant_id, day, last)
    values (p_tenant, p_day, 1)
    on conflict (tenant_id, day) do update set last = c.last + 1
    returning c.last into v_n;
  v_no := (p_order->>'order_prefix') || '-' || p_day || '-' || lpad(v_n::text, 4, '0');

  insert into public.builder_orders (
    tenant_id, order_no, member_id, contact, shipping, items, subtotal, shipping_fee, total,
    status, payment_method, expires_at, access_key_hash, note
  ) values (
    p_tenant, v_no, nullif(p_order->>'member_id', '')::uuid, p_order->'contact', p_order->'shipping', p_items,
    (p_order->>'subtotal')::integer, (p_order->>'shipping_fee')::integer, (p_order->>'total')::integer,
    'pending_payment', p_order->>'payment_method', (p_order->>'expires_at')::timestamptz,
    p_order->>'access_key_hash', p_order->>'note'
  ) returning id into v_id;

  insert into public.builder_order_items (tenant_id, order_id, product_id, variant_id, name, variant_label, sku, unit_price, qty, line_total, stock_deducted)
  select p_tenant, v_id, (e.value->>'product_id')::uuid, nullif(e.value->>'variant_id', '')::uuid, e.value->>'name',
         e.value->>'variant_label', e.value->>'sku', (e.value->>'unit_price')::integer, (e.value->>'qty')::integer,
         (e.value->>'line_total')::integer, (v_deducted->>((e.ordinality - 1)::integer))::boolean
    from jsonb_array_elements(p_items) with ordinality e;

  return query select v_id, v_no;
end;
$$;

-- 回補庫存（冪等）：只有把 stock_released_at 從 null 改掉的那一次會加回庫存。
create or replace function public.builder_release_order_stock(p_tenant uuid, p_order uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.builder_orders set stock_released_at = now(), updated_at = now()
   where id = p_order and tenant_id = p_tenant and stock_released_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update public.builder_products p set stock = p.stock + s.qty
    from (select i.product_id, sum(i.qty)::integer as qty from public.builder_order_items i
           where i.order_id = p_order and i.tenant_id = p_tenant and i.stock_deducted and i.variant_id is null and i.product_id is not null
           group by i.product_id) s
   where p.id = s.product_id and p.tenant_id = p_tenant;
  update public.builder_product_variants v set stock = v.stock + s.qty
    from (select i.variant_id, sum(i.qty)::integer as qty from public.builder_order_items i
           where i.order_id = p_order and i.tenant_id = p_tenant and i.stock_deducted and i.variant_id is not null
           group by i.variant_id) s
   where v.id = s.variant_id and v.tenant_id = p_tenant;
  return true;
end;
$$;

-- 取消：條件式轉換（目前狀態必須在 p_from 內）＋同一交易回補庫存。
create or replace function public.builder_cancel_order(p_tenant uuid, p_order uuid, p_from text[], p_reason text)
returns table (transitioned boolean, stock_released boolean)
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.builder_orders
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, updated_at = now()
   where id = p_order and tenant_id = p_tenant and status = any(p_from);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return query select false, false;
    return;
  end if;
  return query select true, public.builder_release_order_stock(p_tenant, p_order);
end;
$$;

revoke all on function public.builder_place_order(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.builder_release_order_stock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.builder_cancel_order(uuid, uuid, text[], text) from public, anon, authenticated;
grant execute on function public.builder_place_order(uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.builder_release_order_stock(uuid, uuid) to service_role;
grant execute on function public.builder_cancel_order(uuid, uuid, text[], text) to service_role;
