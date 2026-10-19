-- 第八批＋金流第二輪獨立審查修正。
-- 🔴 共用專案：只動 builder_ 物件；函式固定 search_path；只 grant 給 service_role。

-- H-1：cancel_state 區分「確實成功終止委託」(done) 與「回查確認委託未成立、本地取消即可」(not_needed)
alter table public.builder_subscriptions drop constraint if exists builder_subscriptions_cancel_state_check;
alter table public.builder_subscriptions add constraint builder_subscriptions_cancel_state_check
  check (cancel_state in ('none', 'requested', 'done', 'failed', 'not_needed'));
-- 舊資料：沒有 PeriodNo 卻標 done 的（本地取消、從未呼叫終止）→ not_needed（之後若收到每期通知，回填 PeriodNo 後一律真的終止）
update public.builder_subscriptions set cancel_state = 'not_needed' where cancel_state = 'done' and period_no is null;

-- M-2：已出貨訂單退款 → 同一交易釋放這張訂單的報名與預約（簽章不變）
create or replace function public.builder_mark_order_refunded(p_tenant uuid, p_order uuid)
returns setof public.builder_orders
language plpgsql
set search_path = public
as $$
declare
  v_o public.builder_orders%rowtype;
begin
  update public.builder_orders
     set refunded_at = now(), updated_at = now()
   where id = p_order and tenant_id = p_tenant and status = 'fulfilled' and refunded_at is null
  returning * into v_o;
  if v_o.id is null then
    return;
  end if;
  perform public.builder_release_order_credits(p_tenant, p_order);
  update public.builder_event_registrations
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'refunded', updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  update public.builder_bookings
     set status = 'cancelled', cancelled_at = now(), cancel_reason = 'refunded', cancelled_by = 'order', updated_at = now()
   where order_id = p_order and tenant_id = p_tenant and status in ('held', 'confirmed');
  return next v_o;
end;
$$;
revoke all on function public.builder_mark_order_refunded(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_mark_order_refunded(uuid, uuid) to service_role;

-- L-5：QR 掃描報表的「訂單轉換」只算真正付款的訂單（已付款／已出貨、非 sandbox、未退款）。
-- 轉換列仍在下單時記錄（需要當下的掃碼 cookie），未付款／取消的訂單在報表中不計入（簽章不變）。
create or replace function public.builder_qr_scan_report(p_tenant uuid, p_since timestamptz, p_products uuid[] default null)
returns table (product_id uuid, country text, lang text, scans bigint, orders bigint, inquiries bigint)
language sql
stable
set search_path = public
as $$
  select s.product_id, coalesce(s.country, '') as country, s.lang,
         count(distinct s.id) as scans,
         count(distinct c.ref_id) filter (
           where c.kind = 'order' and exists (
             select 1 from public.builder_orders o
              where o.id = c.ref_id and o.tenant_id = s.tenant_id
                and o.status in ('paid', 'fulfilled') and not o.payment_sandbox and o.refunded_at is null)
         ) as orders,
         count(distinct c.ref_id) filter (where c.kind = 'inquiry') as inquiries
    from public.builder_qr_scans s
    left join public.builder_qr_conversions c on c.scan_id = s.id and c.tenant_id = s.tenant_id
   where s.tenant_id = p_tenant and s.scanned_at >= p_since
     and (p_products is null or s.product_id = any(p_products))
   group by s.product_id, coalesce(s.country, ''), s.lang;
$$;
revoke all on function public.builder_qr_scan_report(uuid, timestamptz, uuid[]) from public, anon, authenticated;
grant execute on function public.builder_qr_scan_report(uuid, timestamptz, uuid[]) to service_role;
