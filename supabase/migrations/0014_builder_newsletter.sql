-- newsletter 模組（電子報）：訂閱者（雙重確認）、群發、每封寄送紀錄（一次性退訂 token）。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'unsubscribed')),
  confirm_token_hash text,
  confirm_expires_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);
create index if not exists builder_newsletter_subscribers_token_idx on public.builder_newsletter_subscribers (confirm_token_hash) where confirm_token_hash is not null;

create table if not exists public.builder_newsletter_broadcasts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 150),
  body_md text not null,
  -- draft → sending（條件式，只有一次）→ sent；同一份不能重複群發
  status text not null default 'draft' check (status in ('draft', 'sending', 'sent')),
  test_sent_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.builder_newsletter_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  broadcast_id uuid not null references public.builder_newsletter_broadcasts(id) on delete cascade,
  subscriber_id uuid not null references public.builder_newsletter_subscribers(id) on delete cascade,
  email text not null,
  unsub_token_hash text not null unique,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  error text,
  sent_at timestamptz,
  unsub_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (broadcast_id, subscriber_id)
);
create index if not exists builder_newsletter_deliveries_queue_idx on public.builder_newsletter_deliveries (broadcast_id, status);

alter table public.builder_newsletter_subscribers enable row level security;
alter table public.builder_newsletter_broadcasts enable row level security;
alter table public.builder_newsletter_deliveries enable row level security;
revoke all on table public.builder_newsletter_subscribers, public.builder_newsletter_broadcasts, public.builder_newsletter_deliveries from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_newsletter_subscribers, public.builder_newsletter_broadcasts, public.builder_newsletter_deliveries to service_role;

-- 為所有已確認的訂閱者建立寄送列（同一份 broadcast 同一人只會有一列）
create or replace function public.builder_queue_deliveries(p_tenant uuid, p_broadcast uuid, p_rows jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_n integer;
begin
  insert into public.builder_newsletter_deliveries (tenant_id, broadcast_id, subscriber_id, email, unsub_token_hash)
  select p_tenant, p_broadcast, s.id, s.email, r.value->>'token_hash'
    from jsonb_array_elements(p_rows) r
    join public.builder_newsletter_subscribers s on s.id = (r.value->>'subscriber_id')::uuid
   where s.tenant_id = p_tenant and s.status = 'confirmed'
  on conflict (broadcast_id, subscriber_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.builder_queue_deliveries(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.builder_queue_deliveries(uuid, uuid, jsonb) to service_role;
