-- 第五批：loyalty（會員點數＋等級）＋訂單「折抵／儲值金」欄位與原子扣用骨架。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 🔴 點數帳本只增不改：service_role 只有 select／insert（update／delete／truncate 一律收回）。餘額＝帳本加總。
-- builder_place_order／builder_place_class_order／builder_cancel_order 簽章不變（只改內容；舊版程式不送新欄位 → 新欄位為 0），不需相容層。

-- 訂單：等級折扣、點數折抵、儲值金支付（total ＝ 要用 payment_method 收的金額；credit ＝ 全額由點數／儲值金支付，不經金流）
alter table public.builder_orders add column if not exists tier_discount integer not null default 0 check (tier_discount >= 0);
alter table public.builder_orders add column if not exists points_redeemed integer not null default 0 check (points_redeemed >= 0);
alter table public.builder_orders add column if not exists points_discount integer not null default 0 check (points_discount >= 0);
alter table public.builder_orders add column if not exists wallet_paid integer not null default 0 check (wallet_paid >= 0);
alter table public.builder_orders drop constraint if exists builder_orders_payment_method_check;
alter table public.builder_orders add constraint builder_orders_payment_method_check check (payment_method in ('pchomepay', 'offline', 'credit'));

-- 儲值方案的訂單品項
alter table public.builder_order_items drop constraint if exists builder_order_items_item_kind_check;
alter table public.builder_order_items add constraint builder_order_items_item_kind_check check (item_kind in ('product', 'event_ticket', 'booking', 'course', 'topup'));

create table if not exists public.builder_points_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  -- earn 賺點（＋，有到期日）／redeem 折抵（−）／expire 到期（−）／reverse（＋ 退回折抵、− 收回已賺點數）／adjust 店主調整（±）
  kind text not null check (kind in ('earn', 'redeem', 'expire', 'reverse', 'adjust')),
  amount integer not null check (amount <> 0 and amount between -100000000 and 100000000),
  expires_at timestamptz,
  order_id uuid,
  -- 冪等鍵（例如 order:<id>:earn）：同一個 ref 只會有一筆
  ref text,
  reason text,
  actor text not null default 'system',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, ref),
  check (kind <> 'earn' or (amount > 0 and expires_at is not null)),
  check (kind not in ('redeem', 'expire') or amount < 0)
);
create index if not exists builder_points_ledger_member_idx on public.builder_points_ledger (tenant_id, member_id, created_at);
create index if not exists builder_points_ledger_expiry_idx on public.builder_points_ledger (expires_at) where expires_at is not null;

-- 會員目前等級（快照；權威是「期間內已付款消費」，每日 cron 與付款／取消 hook 重算）
create table if not exists public.builder_member_tiers (
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  tier_id text,
  spend integer not null default 0,
  evaluated_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  primary key (tenant_id, member_id)
);

alter table public.builder_points_ledger enable row level security;
alter table public.builder_member_tiers enable row level security;
revoke all on table public.builder_points_ledger, public.builder_member_tiers from public, anon, authenticated;
grant select, insert on table public.builder_points_ledger to service_role;
revoke update, delete, truncate on table public.builder_points_ledger from service_role;
grant select, insert, update, delete on table public.builder_member_tiers to service_role;

-- 帳本狀態（點數與儲值金共用）：餘額＝加總；可用＝依到期日 FIFO 消耗後「未到期」的剩餘；expired_due＝已到期但尚未寫 expire 的剩餘。
-- 批次（lot）＝正數且非退回（earn／topup／adjust）；退回（reverse／refund 正數）視為「消耗減少」，點數回到原批次（原批次已到期就會再到期）。
create or replace function public.builder_ledger_state(p_table text, p_tenant uuid, p_member uuid, p_now timestamptz)
returns table (balance bigint, available bigint, expired_due bigint, next_expiry timestamptz)
language plpgsql
stable
set search_path = public
as $$
begin
  if p_table not in ('builder_points_ledger', 'builder_wallet_ledger') then
    raise exception 'builder: bad ledger';
  end if;
  return query execute format($q$
    with e as (
      select kind, amount, expires_at, created_at, id from public.%I where tenant_id = $1 and member_id = $2
    ), c as (
      select coalesce(sum(-amount) filter (where amount < 0), 0)
             - coalesce(sum(amount) filter (where amount > 0 and kind in ('reverse', 'refund')), 0) as consumed,
             coalesce(sum(amount), 0) as bal
        from e
    ), lots as (
      select amount, expires_at,
             coalesce(sum(amount) over (order by expires_at nulls last, created_at, id rows between unbounded preceding and 1 preceding), 0) as before
        from e where amount > 0 and kind not in ('reverse', 'refund')
    ), r as (
      select l.expires_at, l.amount - least(l.amount, greatest(0, greatest((select consumed from c), 0) - l.before)) as remaining from lots l
    )
    select (select bal from c)::bigint,
           greatest(0, least((select bal from c), coalesce((select sum(remaining) from r where expires_at is null or expires_at > $3), 0)))::bigint,
           coalesce((select sum(remaining) from r where expires_at is not null and expires_at <= $3), 0)::bigint,
           (select min(expires_at) from r where remaining > 0 and expires_at > $3)
  $q$, p_table) using p_tenant, p_member, p_now;
end;
$$;

-- 記帳（唯一的寫入入口）：每位會員一把交易鎖（advisory），同一 ref 冪等；先把已到期的寫成 expire，再處理本筆。
-- p_mode：credit（入帳，正數）／strict（扣帳，可用不足 raise）／capped（扣帳，最多扣到可用為止，不足部分記在 meta.shortfall）
create or replace function public.builder_ledger_post(
  p_table text, p_tenant uuid, p_member uuid, p_kind text, p_amount integer, p_expires timestamptz,
  p_ref text, p_order uuid, p_reason text, p_actor text, p_meta jsonb, p_mode text
)
returns table (posted boolean, amount integer, balance bigint)
language plpgsql
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_state record;
  v_amt integer := p_amount;
  v_meta jsonb := coalesce(p_meta, '{}'::jsonb);
  v_existing integer;
begin
  if p_table not in ('builder_points_ledger', 'builder_wallet_ledger') then
    raise exception 'builder: bad ledger';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'builder: bad amount';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_table || ':' || p_tenant::text || ':' || p_member::text, 0));
  if p_ref is not null then
    execute format('select amount from public.%I where tenant_id = $1 and ref = $2', p_table) into v_existing using p_tenant, p_ref;
    if v_existing is not null then
      select * into v_state from public.builder_ledger_state(p_table, p_tenant, p_member, now());
      return query select false, v_existing, v_state.balance;
      return;
    end if;
  end if;
  -- lazy 到期：已過期的剩餘先寫成 expire（ref 為 null，所以不受冪等鍵限制）
  select * into v_state from public.builder_ledger_state(p_table, p_tenant, p_member, now());
  if v_state.expired_due > 0 then
    execute format('insert into public.%I (tenant_id, member_id, kind, amount, reason, actor) values ($1, $2, ''expire'', $3, ''到期'', ''system'')', p_table)
      using p_tenant, p_member, -(v_state.expired_due::integer);
    select * into v_state from public.builder_ledger_state(p_table, p_tenant, p_member, now());
  end if;
  if p_mode = 'credit' then
    if p_amount < 0 then
      raise exception 'builder: bad amount';
    end if;
  elsif p_mode = 'strict' then
    if p_amount > 0 then
      raise exception 'builder: bad amount';
    end if;
    if v_state.available < -p_amount then
      raise exception 'builder: % insufficient', case when p_table = 'builder_points_ledger' then 'points' else 'wallet' end;
    end if;
  elsif p_mode = 'capped' then
    if p_amount > 0 then
      raise exception 'builder: bad amount';
    end if;
    if v_state.available < -p_amount then
      v_amt := -(v_state.available::integer);
      v_meta := v_meta || jsonb_build_object('requested', -p_amount, 'shortfall', -p_amount - v_state.available);
    end if;
    if v_amt = 0 then
      -- 什麼都扣不到：仍留一筆 0 元紀錄不行（amount <> 0），改寫稽核由呼叫端處理；回傳 posted=false
      return query select false, 0, v_state.balance;
      return;
    end if;
  else
    raise exception 'builder: bad mode';
  end if;
  execute format('insert into public.%I (tenant_id, member_id, kind, amount, expires_at, order_id, ref, reason, actor, meta) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', p_table)
    using p_tenant, p_member, p_kind, v_amt, p_expires, p_order, p_ref, p_reason, coalesce(p_actor, 'system'), v_meta;
  select * into v_state from public.builder_ledger_state(p_table, p_tenant, p_member, now());
  return query select true, v_amt, v_state.balance;
end;
$$;

-- 只做到期（cron 用）：鎖會員 → 已到期的剩餘寫成 expire。回傳寫入的點數（0＝沒有到期的）
create or replace function public.builder_ledger_expire(p_table text, p_tenant uuid, p_member uuid)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_state record;
begin
  if p_table not in ('builder_points_ledger', 'builder_wallet_ledger') then
    raise exception 'builder: bad ledger';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_table || ':' || p_tenant::text || ':' || p_member::text, 0));
  select * into v_state from public.builder_ledger_state(p_table, p_tenant, p_member, now());
  if v_state.expired_due <= 0 then
    return 0;
  end if;
  execute format('insert into public.%I (tenant_id, member_id, kind, amount, reason, actor) values ($1, $2, ''expire'', $3, ''到期'', ''system'')', p_table)
    using p_tenant, p_member, -(v_state.expired_due::integer);
  return v_state.expired_due::integer;
end;
$$;

-- 下單時的折抵／儲值金（在 builder_place_order／builder_place_class_order 同一交易內呼叫）：
-- 寫回訂單欄位、原子扣點（可用不足 raise → 整筆訂單回滾，併發不超用）。wallet 由 0021 擴充。
create or replace function public.builder_apply_order_credits(p_tenant uuid, p_order uuid, p_input jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_member uuid := nullif(p_input->>'member_id', '')::uuid;
  v_points integer := coalesce((p_input->>'points_redeemed')::integer, 0);
  v_wallet integer := coalesce((p_input->>'wallet_paid')::integer, 0);
begin
  update public.builder_orders
     set tier_discount = coalesce((p_input->>'tier_discount')::integer, 0),
         points_redeemed = v_points,
         points_discount = coalesce((p_input->>'points_discount')::integer, 0),
         wallet_paid = v_wallet
   where id = p_order and tenant_id = p_tenant;
  if (v_points > 0 or v_wallet > 0) and v_member is null then
    raise exception 'builder: credits need member';
  end if;
  if v_points > 0 then
    perform public.builder_ledger_post('builder_points_ledger', p_tenant, v_member, 'redeem', -v_points, null,
      'order:' || p_order::text || ':redeem', p_order, '訂單折抵', 'checkout', '{}'::jsonb, 'strict');
  end if;
  if v_wallet > 0 then
    raise exception 'builder: wallet unavailable';
  end if;
end;
$$;

-- 取消／逾期：退回這張訂單折抵的點數（冪等：ref 唯一）。wallet 由 0021 擴充。
create or replace function public.builder_release_order_credits(p_tenant uuid, p_order uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_o record;
begin
  select member_id, points_redeemed, wallet_paid into v_o from public.builder_orders where id = p_order and tenant_id = p_tenant;
  if v_o.member_id is null then
    return;
  end if;
  if v_o.points_redeemed > 0 and exists (select 1 from public.builder_points_ledger where tenant_id = p_tenant and ref = 'order:' || p_order::text || ':redeem') then
    perform public.builder_ledger_post('builder_points_ledger', p_tenant, v_o.member_id, 'reverse', v_o.points_redeemed, null,
      'order:' || p_order::text || ':redeem_refund', p_order, '訂單取消，退回折抵點數', 'system', '{}'::jsonb, 'credit');
  end if;
end;
$$;

-- 期間內的已付款消費（等級用）：商品淨額（小計 − 折扣碼 − 等級折扣 − 點數折抵），不含運費、不含儲值方案、不含 sandbox
create or replace function public.builder_member_spend(p_tenant uuid, p_member uuid, p_since timestamptz)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(greatest(0, subtotal - discount_total - tier_discount - points_discount)), 0)::bigint
    from public.builder_orders
   where tenant_id = p_tenant and member_id = p_member
     and status in ('paid', 'fulfilled') and not payment_sandbox
     and (p_since is null or paid_at >= p_since)
     and not (items @> '[{"item_kind":"topup"}]'::jsonb);
$$;

-- 下單（0010 內容＋折抵）：簽章不變。🔴 優惠券區塊與 builder_place_class_order 相同，兩邊要一起維護。
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

  -- 第五批：等級折扣／點數折抵／儲值金（原子扣用，不足整筆回滾）
  perform public.builder_apply_order_credits(p_tenant, v_id, p_order);

  return query select v_id, v_no;
end;
$$;

-- 課程類訂單（0017 內容＋折抵＋儲值方案品項）：簽章不變
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

  perform public.builder_apply_order_credits(p_tenant, v_id, p_order);
  v_res := public.builder_reserve_for_order(p_tenant, v_id, p_res);
  return query select v_id, v_no, v_res;
end;
$$;

-- 取消：條件式轉換＋同一交易回補庫存、優惠券、名額、折抵（簽章不變）
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
  perform public.builder_release_order_credits(p_tenant, p_order);
  return query select true, v_stock;
end;
$$;

revoke all on function public.builder_ledger_state(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.builder_ledger_post(text, uuid, uuid, text, integer, timestamptz, text, uuid, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.builder_ledger_expire(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_ledger_expire(text, uuid, uuid) to service_role;
revoke all on function public.builder_apply_order_credits(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.builder_release_order_credits(uuid, uuid) from public, anon, authenticated;
revoke all on function public.builder_member_spend(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.builder_place_order(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.builder_place_class_order(uuid, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.builder_cancel_order(uuid, uuid, text[], text) from public, anon, authenticated;
grant execute on function public.builder_ledger_state(text, uuid, uuid, timestamptz) to service_role;
grant execute on function public.builder_ledger_post(text, uuid, uuid, text, integer, timestamptz, text, uuid, text, text, jsonb, text) to service_role;
grant execute on function public.builder_apply_order_credits(uuid, uuid, jsonb) to service_role;
grant execute on function public.builder_release_order_credits(uuid, uuid) to service_role;
grant execute on function public.builder_member_spend(uuid, uuid, timestamptz) to service_role;
grant execute on function public.builder_place_order(uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.builder_place_class_order(uuid, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.builder_cancel_order(uuid, uuid, text[], text) to service_role;
