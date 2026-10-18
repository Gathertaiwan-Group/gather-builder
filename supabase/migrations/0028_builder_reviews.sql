-- 第六批：reviews（商品評價）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role。
-- 只有「該訂單的會員本人、訂單已付款或已出貨、訂單裡有這個商品」才能評價；同一訂單同一商品只能一則（unique）。
-- 預設 pending（店主審核後才公開）。內文為純文字（前台一律轉義），圖片只接受白名單網域的 https 網址。

create table if not exists public.builder_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  product_id uuid not null references public.builder_products(id) on delete cascade,
  order_id uuid not null references public.builder_orders(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  -- 顯示用暱稱（已遮罩）
  display_name text not null check (char_length(display_name) between 1 and 40),
  rating integer not null check (rating between 1 and 5),
  body text not null default '' check (char_length(body) <= 2000),
  images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 4),
  status text not null default 'pending' check (status in ('pending', 'published', 'hidden')),
  reply text check (reply is null or char_length(reply) <= 1000),
  replied_at timestamptz,
  moderated_by text,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, product_id)
);
create index if not exists builder_reviews_product_idx on public.builder_reviews (tenant_id, product_id, status, created_at desc);

alter table public.builder_reviews enable row level security;
revoke all on table public.builder_reviews from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_reviews to service_role;
