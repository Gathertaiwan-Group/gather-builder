-- 金流獨立審查修正（2026-10-18）：
-- H1 sandbox 付款成功的訂單要能辨識（payment_sandbox），不能出貨
-- H2 逾期取消前的權威回查：記錄回查連續失敗次數與警示時間（同一筆付款只警示一次）
-- 全部是加欄位（有預設值），線上舊版程式可照常運作（不需相容層）。

alter table public.builder_orders add column if not exists payment_sandbox boolean not null default false;

alter table public.builder_payments add column if not exists query_failures integer not null default 0;
alter table public.builder_payments add column if not exists last_query_error text;
alter table public.builder_payments add column if not exists alerted_at timestamptz;

-- 既有 sandbox 付款成功的訂單補標記
update public.builder_orders o
   set payment_sandbox = true
  from public.builder_payments p
 where p.order_id = o.id and p.tenant_id = o.tenant_id and p.sandbox and p.status in ('paid', 'paid_after_cancel')
   and not o.payment_sandbox;

-- 下單前釋放逾期保留用：依商品找逾期未付的訂單
create index if not exists builder_order_items_product_idx on public.builder_order_items (product_id);

revoke all on table public.builder_orders, public.builder_payments from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_orders, public.builder_payments to service_role;
