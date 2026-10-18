-- 第八批：qr-catalog（實體門市 QR 多語商品頁＋出海資料）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role；函式固定 search_path。
-- 掃描紀錄與轉換紀錄只增不改（service_role 只有 select／insert）。🔴 掃描不存 IP（只存國家碼）。

-- 商品品牌（品牌報表用；可空）
alter table public.builder_products add column if not exists brand text check (brand is null or char_length(brand) between 1 and 80);
create index if not exists builder_products_brand_idx on public.builder_products (tenant_id, brand) where brand is not null;

-- 每個商品一組 QR 短碼（10 字隨機英數，約 59 bits；同站唯一）
create table if not exists public.builder_qr_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  product_id uuid not null references public.builder_products(id) on delete cascade,
  code text not null check (code ~ '^[A-Za-z0-9]{10}$'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, product_id)
);

-- 掃描紀錄：時間、商品、語言、國家碼（只來自 Vercel 的 x-vercel-ip-country；可缺）。不存 IP、不存 UA。
create table if not exists public.builder_qr_scans (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  qr_id uuid not null references public.builder_qr_codes(id) on delete cascade,
  product_id uuid not null references public.builder_products(id) on delete cascade,
  lang text not null check (lang ~ '^[a-zA-Z-]{2,10}$'),
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  scanned_at timestamptz not null default now()
);
create index if not exists builder_qr_scans_tenant_idx on public.builder_qr_scans (tenant_id, scanned_at desc);
create index if not exists builder_qr_scans_product_idx on public.builder_qr_scans (tenant_id, product_id, scanned_at desc);

-- 轉換：掃碼後的線上訂單／海外寄送詢價（每張訂單×商品、每筆詢價只記一次）
create table if not exists public.builder_qr_conversions (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  scan_id bigint not null references public.builder_qr_scans(id) on delete cascade,
  product_id uuid not null references public.builder_products(id) on delete cascade,
  kind text not null check (kind in ('order', 'inquiry')),
  ref_id uuid not null,
  created_at timestamptz not null default now(),
  unique (kind, ref_id, product_id)
);
create index if not exists builder_qr_conversions_scan_idx on public.builder_qr_conversions (tenant_id, scan_id);

-- 品牌（廠商）唯讀報表連結：簽章（HMAC，不存原文）＋可撤銷＋到期
create table if not exists public.builder_brand_report_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  brand text not null check (char_length(brand) between 1 and 80),
  label text check (label is null or char_length(label) <= 80),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists builder_brand_report_links_tenant_idx on public.builder_brand_report_links (tenant_id, created_at desc);

-- 掃描報表：商品 × 國家 × 語言的掃描數與轉換數
create or replace function public.builder_qr_scan_report(p_tenant uuid, p_since timestamptz, p_products uuid[] default null)
returns table (product_id uuid, country text, lang text, scans bigint, orders bigint, inquiries bigint)
language sql
stable
set search_path = public
as $$
  select s.product_id, coalesce(s.country, '') as country, s.lang,
         count(distinct s.id) as scans,
         count(distinct c.ref_id) filter (where c.kind = 'order') as orders,
         count(distinct c.ref_id) filter (where c.kind = 'inquiry') as inquiries
    from public.builder_qr_scans s
    left join public.builder_qr_conversions c on c.scan_id = s.id and c.tenant_id = s.tenant_id
   where s.tenant_id = p_tenant and s.scanned_at >= p_since
     and (p_products is null or s.product_id = any(p_products))
   group by s.product_id, coalesce(s.country, ''), s.lang;
$$;

-- 品牌報表的銷售統計（已付款／已出貨、非 sandbox、未退款）：只回數量與金額，不回任何訂單或客人資料
create or replace function public.builder_brand_sales(p_tenant uuid, p_products uuid[], p_since timestamptz)
returns table (product_id uuid, qty bigint, revenue bigint, orders bigint)
language sql
stable
set search_path = public
as $$
  select i.product_id, coalesce(sum(i.qty), 0)::bigint, coalesce(sum(i.line_total), 0)::bigint, count(distinct o.id)
    from public.builder_order_items i
    join public.builder_orders o on o.id = i.order_id and o.tenant_id = i.tenant_id
   where i.tenant_id = p_tenant and i.product_id = any(p_products)
     and o.status in ('paid', 'fulfilled') and not o.payment_sandbox and o.refunded_at is null
     and o.paid_at >= p_since
   group by i.product_id;
$$;

alter table public.builder_qr_codes enable row level security;
alter table public.builder_qr_scans enable row level security;
alter table public.builder_qr_conversions enable row level security;
alter table public.builder_brand_report_links enable row level security;
revoke all on table public.builder_qr_codes, public.builder_qr_scans, public.builder_qr_conversions, public.builder_brand_report_links from public, anon, authenticated;
revoke all on sequence public.builder_qr_scans_id_seq, public.builder_qr_conversions_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_qr_codes, public.builder_brand_report_links to service_role;
grant select, insert on table public.builder_qr_scans, public.builder_qr_conversions to service_role;
revoke update, delete, truncate on table public.builder_qr_scans, public.builder_qr_conversions from service_role;
grant usage on sequence public.builder_qr_scans_id_seq, public.builder_qr_conversions_id_seq to service_role;

revoke all on function public.builder_qr_scan_report(uuid, timestamptz, uuid[]) from public, anon, authenticated;
revoke all on function public.builder_brand_sales(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.builder_qr_scan_report(uuid, timestamptz, uuid[]) to service_role;
grant execute on function public.builder_brand_sales(uuid, uuid[], timestamptz) to service_role;
