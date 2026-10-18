-- shop 強化（獨立審查回饋）：
-- M1 回補庫存依「下單時從哪裡扣」的快照（deducted_from），規格被刪除後（variant_id 變 null）不會誤補到商品層
-- L2 訂單流水號 ≥ 10000 時不截斷（lpad 會截字）
-- L3 扣庫存依 (product_id, variant_id) 排序上鎖，避免多品項併發 deadlock
-- 函式簽章不變：線上舊版程式可直接沿用（不需相容層）。

alter table public.builder_order_items add column if not exists deducted_from text
  check (deducted_from is null or deducted_from in ('product', 'variant'));
update public.builder_order_items
   set deducted_from = case when variant_id is null then 'product' else 'variant' end
 where deducted_from is null and stock_deducted;

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
    status, payment_method, expires_at, access_key_hash, note
  ) values (
    p_tenant, v_no, nullif(p_order->>'member_id', '')::uuid, p_order->'contact', p_order->'shipping', p_items,
    (p_order->>'subtotal')::integer, (p_order->>'shipping_fee')::integer, (p_order->>'total')::integer,
    'pending_payment', p_order->>'payment_method', (p_order->>'expires_at')::timestamptz,
    p_order->>'access_key_hash', p_order->>'note'
  ) returning id into v_id;

  insert into public.builder_order_items (tenant_id, order_id, product_id, variant_id, name, variant_label, sku, unit_price, qty, line_total, stock_deducted, deducted_from)
  select p_tenant, v_id, (e.value->>'product_id')::uuid, nullif(e.value->>'variant_id', '')::uuid, e.value->>'name',
         e.value->>'variant_label', e.value->>'sku', (e.value->>'unit_price')::integer, (e.value->>'qty')::integer,
         (e.value->>'line_total')::integer, (v_map->>(e.ordinality::text))::boolean,
         case when (v_map->>(e.ordinality::text))::boolean
              then case when nullif(e.value->>'variant_id', '') is null then 'product' else 'variant' end end
    from jsonb_array_elements(p_items) with ordinality e;

  return query select v_id, v_no;
end;
$$;

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
  -- 只補「從商品層扣的」；規格品項的規格若已刪除（variant_id 變 null）就不補，絕不誤補到商品層
  update public.builder_products p set stock = p.stock + s.qty
    from (select i.product_id, sum(i.qty)::integer as qty from public.builder_order_items i
           where i.order_id = p_order and i.tenant_id = p_tenant and i.stock_deducted and i.deducted_from = 'product' and i.product_id is not null
           group by i.product_id) s
   where p.id = s.product_id and p.tenant_id = p_tenant;
  update public.builder_product_variants v set stock = v.stock + s.qty
    from (select i.variant_id, sum(i.qty)::integer as qty from public.builder_order_items i
           where i.order_id = p_order and i.tenant_id = p_tenant and i.stock_deducted and i.deducted_from = 'variant' and i.variant_id is not null
           group by i.variant_id) s
   where v.id = s.variant_id and v.tenant_id = p_tenant;
  return true;
end;
$$;

revoke all on function public.builder_place_order(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.builder_release_order_stock(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_place_order(uuid, jsonb, jsonb, text) to service_role;
grant execute on function public.builder_release_order_stock(uuid, uuid) to service_role;
