-- 第八批：group-buy（團購）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role；函式固定 search_path。
-- 下單一律走既有 builder_place_order（同一交易內先原子扣團購限量，再呼叫它扣庫存／編號／優惠券／折抵）。
-- 取消／sandbox 付款在同一交易釋放團購限量（builder_cancel_order／builder_mark_paid_sandbox 簽章不變）。
-- 只增不改：分潤帳 builder_group_buy_commissions、通知紀錄 builder_group_buy_notices（service_role 只有 select／insert）。
-- 銀行明細配對：一筆明細只能有一筆有效（建議／已確認）配對、一張訂單只能有一筆有效配對（partial unique index）。

-- ================================================================ 團購活動
create table if not exists public.builder_group_buys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  title text not null check (char_length(title) between 1 and 160),
  description_md text not null default '' check (char_length(description_md) <= 20000),
  cover_url text check (cover_url is null or char_length(cover_url) <= 1000),
  -- draft 草稿／published 開團中／closed 已結團（成團）／failed 未達門檻（已取消訂單）／cancelled 店主取消
  status text not null default 'draft' check (status in ('draft', 'published', 'closed', 'failed', 'cancelled')),
  starts_at timestamptz,
  ends_at timestamptz not null,
  -- 成團門檻（總件數，null＝不設門檻）
  min_qty integer check (min_qty is null or min_qty between 1 and 1000000),
  -- 到店自取點 [{id, name, address, hours}]
  pickup_points jsonb not null default '[]'::jsonb check (jsonb_typeof(pickup_points) = 'array'),
  -- 允許的 shipping 模組運送方式 id（null＝全部）
  shipping_method_ids jsonb check (shipping_method_ids is null or jsonb_typeof(shipping_method_ids) = 'array'),
  closed_at timestamptz,
  -- 結團後的處理（通知、未成團取消）全部完成的時間；null＝還要（再）處理
  settled_at timestamptz,
  copied_from uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug),
  check (starts_at is null or ends_at > starts_at)
);
create index if not exists builder_group_buys_tenant_idx on public.builder_group_buys (tenant_id, status, ends_at);
create index if not exists builder_group_buys_due_idx on public.builder_group_buys (ends_at) where status = 'published';
create index if not exists builder_group_buys_unsettled_idx on public.builder_group_buys (closed_at) where settled_at is null and status in ('closed', 'failed');

-- 團購品項：團購價（可與一般售價不同）、每品項限量（sold 原子累加，DB check 保證不超過 quota）
create table if not exists public.builder_group_buy_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  group_buy_id uuid not null references public.builder_group_buys(id) on delete cascade,
  product_id uuid not null references public.builder_products(id) on delete cascade,
  variant_id uuid,
  price integer not null check (price between 0 and 10000000),
  quota integer check (quota is null or quota between 1 and 1000000),
  sold integer not null default 0 check (sold >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  check (quota is null or sold <= quota)
);
create unique index if not exists builder_group_buy_items_uniq on public.builder_group_buy_items (group_buy_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists builder_group_buy_items_gb_idx on public.builder_group_buy_items (tenant_id, group_buy_id, sort);

-- 團主（KOL）
create table if not exists public.builder_group_buy_leaders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  email text not null check (char_length(email) between 3 and 200),
  email_norm text not null,
  code text not null check (code ~ '^[A-Z2-9]{8}$'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- 報表簽章連結的版本：+1 讓舊連結失效
  report_version integer not null default 1 check (report_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, email_norm)
);

-- 團主 × 團購（分潤設定：percent＝萬分比 basis points；fixed＝每張訂單 NT$）
create table if not exists public.builder_group_buy_leader_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  group_buy_id uuid not null references public.builder_group_buys(id) on delete cascade,
  leader_id uuid not null references public.builder_group_buy_leaders(id) on delete cascade,
  commission_kind text not null check (commission_kind in ('percent', 'fixed')),
  commission_value integer not null check (commission_value between 0 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (group_buy_id, leader_id),
  check (commission_kind <> 'percent' or commission_value <= 5000)
);

-- 訂單標記（主表另有 group_buy_id／group_buy_leader_id 欄位）
alter table public.builder_orders add column if not exists group_buy_id uuid references public.builder_group_buys(id) on delete set null;
alter table public.builder_orders add column if not exists group_buy_leader_id uuid references public.builder_group_buy_leaders(id) on delete set null;
create index if not exists builder_orders_group_buy_idx on public.builder_orders (tenant_id, group_buy_id, created_at desc) where group_buy_id is not null;
create index if not exists builder_orders_gb_leader_idx on public.builder_orders (tenant_id, group_buy_leader_id, created_at desc) where group_buy_leader_id is not null;

-- 團購單的延伸資料：限量扣了哪些品項（回補只補這些）、匯款帳號末五碼、下單當下的分潤設定快照
create table if not exists public.builder_group_buy_orders (
  order_id uuid primary key references public.builder_orders(id) on delete cascade,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  group_buy_id uuid not null references public.builder_group_buys(id) on delete cascade,
  leader_id uuid references public.builder_group_buy_leaders(id) on delete set null,
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  payer_last5 text check (payer_last5 is null or payer_last5 ~ '^[0-9]{5}$'),
  commission_kind text check (commission_kind is null or commission_kind in ('percent', 'fixed')),
  commission_value integer,
  quota_released_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists builder_group_buy_orders_gb_idx on public.builder_group_buy_orders (tenant_id, group_buy_id);

-- 團主分潤帳（只增不改：earn／reverse，unique(訂單, 種類) 各只一筆）
create table if not exists public.builder_group_buy_commissions (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  group_buy_id uuid not null references public.builder_group_buys(id) on delete cascade,
  leader_id uuid not null references public.builder_group_buy_leaders(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  kind text not null check (kind in ('earn', 'reverse')),
  amount integer not null,
  base integer not null,
  created_at timestamptz not null default now(),
  unique (order_id, kind)
);
create index if not exists builder_group_buy_commissions_leader_idx on public.builder_group_buy_commissions (tenant_id, leader_id, created_at desc);

-- 成團／未成團通知（只增不改：每張訂單每種通知只一筆＝只寄一次）
create table if not exists public.builder_group_buy_notices (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  group_buy_id uuid not null references public.builder_group_buys(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  kind text not null check (kind in ('formed', 'failed')),
  created_at timestamptz not null default now(),
  unique (group_buy_id, order_id, kind)
);

-- ================================================================ 銀行明細對帳
create table if not exists public.builder_bank_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  filename text check (filename is null or char_length(filename) <= 200),
  row_count integer not null default 0,
  inserted_count integer not null default 0,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.builder_bank_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  import_id uuid not null references public.builder_bank_imports(id) on delete cascade,
  txn_date date not null,
  amount integer not null check (amount between 1 and 100000000),
  last5 text check (last5 is null or last5 ~ '^[0-9]{5}$'),
  memo text check (memo is null or char_length(memo) <= 200),
  -- 同一份明細重複匯入不重複建立（雜湊：日期、金額、末五碼、備註、同檔第幾筆）
  fingerprint text not null,
  status text not null default 'unmatched' check (status in ('unmatched', 'suggested', 'ambiguous', 'confirmed', 'ignored')),
  created_at timestamptz not null default now(),
  unique (tenant_id, fingerprint)
);
create index if not exists builder_bank_lines_status_idx on public.builder_bank_lines (tenant_id, status, txn_date);

create table if not exists public.builder_bank_matches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  line_id uuid not null references public.builder_bank_lines(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  status text not null default 'suggested' check (status in ('suggested', 'confirmed', 'rejected')),
  reason text check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);
-- 🔴 一筆明細只能配一張單、一張單只能被一筆明細配（建議中或已確認）
create unique index if not exists builder_bank_matches_line_uniq on public.builder_bank_matches (line_id) where status in ('suggested', 'confirmed');
create unique index if not exists builder_bank_matches_order_uniq on public.builder_bank_matches (order_id) where status in ('suggested', 'confirmed');
create index if not exists builder_bank_matches_tenant_idx on public.builder_bank_matches (tenant_id, status, created_at desc);

-- ================================================================ 函式

-- 團購下單：鎖團購（FOR SHARE：下單之間不互鎖，結團的 update 會等它們）→ 依品項 id 排序逐項原子扣限量 →
-- 呼叫既有 builder_place_order（扣庫存、編號、優惠券、折抵；任一不足整筆回滾）→ 標記訂單＋寫延伸資料。
create or replace function public.builder_place_group_buy_order(p_tenant uuid, p_order jsonb, p_items jsonb, p_day text, p_gb jsonb)
returns table (order_id uuid, order_no text)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_gb public.builder_group_buys%rowtype;
  v_line jsonb;
  v_ok uuid;
  v_oid uuid;
  v_no text;
  v_qty integer;
begin
  if jsonb_typeof(p_gb->'lines') <> 'array' or jsonb_array_length(p_gb->'lines') = 0 then
    raise exception 'builder: group buy empty';
  end if;
  select * into v_gb from public.builder_group_buys g
   where g.id = (p_gb->>'group_buy_id')::uuid and g.tenant_id = p_tenant
   for share;
  if v_gb.id is null or v_gb.status <> 'published' or (v_gb.starts_at is not null and v_gb.starts_at > now()) or v_gb.ends_at <= now() then
    raise exception 'builder: group buy closed';
  end if;
  for v_line in
    select e.value from jsonb_array_elements(p_gb->'lines') e order by e.value->>'item_id'
  loop
    v_qty := (v_line->>'qty')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'builder: group buy empty';
    end if;
    v_ok := null;
    update public.builder_group_buy_items i
       set sold = i.sold + v_qty
     where i.id = (v_line->>'item_id')::uuid and i.group_buy_id = v_gb.id and i.tenant_id = p_tenant
       and (i.quota is null or i.sold + v_qty <= i.quota)
    returning i.id into v_ok;
    if v_ok is null then
      raise exception 'builder: group buy quota: %', coalesce(v_line->>'name', '?');
    end if;
  end loop;

  select r.order_id, r.order_no into v_oid, v_no from public.builder_place_order(p_tenant, p_order, p_items, p_day) r;

  update public.builder_orders o
     set group_buy_id = v_gb.id, group_buy_leader_id = nullif(p_gb->>'leader_id', '')::uuid
   where o.id = v_oid and o.tenant_id = p_tenant;
  insert into public.builder_group_buy_orders (order_id, tenant_id, group_buy_id, leader_id, lines, payer_last5, commission_kind, commission_value)
  values (v_oid, p_tenant, v_gb.id, nullif(p_gb->>'leader_id', '')::uuid, p_gb->'lines', nullif(p_gb->>'payer_last5', ''),
          nullif(p_gb->>'commission_kind', ''), nullif(p_gb->>'commission_value', '')::integer);
  return query select v_oid, v_no;
end;
$$;

-- 冪等釋放團購限量（quota_released_at 為冪等旗標；只補這張單扣過的品項）
create or replace function public.builder_release_group_buy_quota(p_tenant uuid, p_order uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_lines jsonb;
  v_line jsonb;
begin
  update public.builder_group_buy_orders
     set quota_released_at = now()
   where order_id = p_order and tenant_id = p_tenant and quota_released_at is null
  returning lines into v_lines;
  if v_lines is null then
    return false;
  end if;
  for v_line in select e.value from jsonb_array_elements(v_lines) e order by e.value->>'item_id'
  loop
    update public.builder_group_buy_items
       set sold = greatest(0, sold - (v_line->>'qty')::integer)
     where id = (v_line->>'item_id')::uuid and tenant_id = p_tenant;
  end loop;
  return true;
end;
$$;

-- 取消（0021 內容＋團購限量）：簽章不變。團購限量先於庫存釋放（與下單「品項→商品」的鎖順序一致，避免死結）
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
  perform public.builder_release_group_buy_quota(p_tenant, p_order);
  v_stock := public.builder_release_order_stock(p_tenant, p_order);
  perform public.builder_release_coupon(p_tenant, p_order);
  perform public.builder_release_order_reservations(p_tenant, p_order);
  perform public.builder_release_order_credits(p_tenant, p_order);
  return query select true, v_stock;
end;
$$;

-- sandbox 付款（0030 內容＋團購限量：測試付款不佔限量）：簽章不變
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
  perform public.builder_release_coupon(p_tenant, p_order);
  perform public.builder_release_order_credits(p_tenant, p_order);
  perform public.builder_release_group_buy_quota(p_tenant, p_order);
  return next v_o;
end;
$$;

-- 確認銀行明細配對（單一交易）：建議 → 已確認（partial unique 保證一筆明細／一張單只配一次）→ 訂單 pending_payment → paid（只限線下匯款）。
-- 訂單已不能收款（已取消、已付款、不是線下匯款）→ raise，整筆回滾（配對維持建議中，由呼叫端改成 rejected）。
create or replace function public.builder_confirm_bank_match(p_tenant uuid, p_match uuid, p_by text)
returns setof public.builder_orders
language plpgsql
set search_path = public
as $$
declare
  v_order uuid;
  v_line uuid;
  v_o public.builder_orders%rowtype;
begin
  update public.builder_bank_matches
     set status = 'confirmed', decided_at = now(), decided_by = p_by
   where id = p_match and tenant_id = p_tenant and status = 'suggested'
  returning order_id, line_id into v_order, v_line;
  if v_order is null then
    return;
  end if;
  update public.builder_orders
     set status = 'paid', paid_at = now(), updated_at = now()
   where id = v_order and tenant_id = p_tenant and status = 'pending_payment' and payment_method = 'offline'
  returning * into v_o;
  if v_o.id is null then
    raise exception 'builder: bank match order not payable';
  end if;
  update public.builder_bank_lines set status = 'confirmed' where id = v_line and tenant_id = p_tenant;
  return next v_o;
end;
$$;

-- ================================================================ 權限
alter table public.builder_group_buys enable row level security;
alter table public.builder_group_buy_items enable row level security;
alter table public.builder_group_buy_leaders enable row level security;
alter table public.builder_group_buy_leader_assignments enable row level security;
alter table public.builder_group_buy_orders enable row level security;
alter table public.builder_group_buy_commissions enable row level security;
alter table public.builder_group_buy_notices enable row level security;
alter table public.builder_bank_imports enable row level security;
alter table public.builder_bank_lines enable row level security;
alter table public.builder_bank_matches enable row level security;

revoke all on table public.builder_group_buys, public.builder_group_buy_items, public.builder_group_buy_leaders, public.builder_group_buy_leader_assignments,
  public.builder_group_buy_orders, public.builder_group_buy_commissions, public.builder_group_buy_notices,
  public.builder_bank_imports, public.builder_bank_lines, public.builder_bank_matches from public, anon, authenticated;
revoke all on sequence public.builder_group_buy_commissions_id_seq, public.builder_group_buy_notices_id_seq from public, anon, authenticated;

grant select, insert, update, delete on table public.builder_group_buys, public.builder_group_buy_items, public.builder_group_buy_leaders,
  public.builder_group_buy_leader_assignments, public.builder_group_buy_orders, public.builder_bank_imports, public.builder_bank_lines, public.builder_bank_matches to service_role;
grant select, insert on table public.builder_group_buy_commissions, public.builder_group_buy_notices to service_role;
revoke update, delete, truncate on table public.builder_group_buy_commissions, public.builder_group_buy_notices from service_role;
grant usage on sequence public.builder_group_buy_commissions_id_seq, public.builder_group_buy_notices_id_seq to service_role;

revoke all on function public.builder_place_group_buy_order(uuid, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.builder_release_group_buy_quota(uuid, uuid) from public, anon, authenticated;
revoke all on function public.builder_cancel_order(uuid, uuid, text[], text) from public, anon, authenticated;
revoke all on function public.builder_mark_paid_sandbox(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.builder_confirm_bank_match(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.builder_place_group_buy_order(uuid, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.builder_release_group_buy_quota(uuid, uuid) to service_role;
grant execute on function public.builder_cancel_order(uuid, uuid, text[], text) to service_role;
grant execute on function public.builder_mark_paid_sandbox(uuid, uuid, timestamptz) to service_role;
grant execute on function public.builder_confirm_bank_match(uuid, uuid, text) to service_role;

-- 超商選店：團購頁選完門市要回到團購頁（只接受 /groupbuy/<slug>）
alter table public.builder_cvs_selections add column if not exists return_path text check (return_path is null or return_path ~ '^/groupbuy/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$');
