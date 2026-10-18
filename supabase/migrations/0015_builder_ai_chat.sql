-- ai-chat 模組（AI 客服）：對話紀錄（每租戶每 session 一列）。限流沿用 builder_rate_limits／builder_rate_hit。
-- 🔴 共用專案：builder_ 前綴、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_ai_chats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  session_id text not null check (session_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  ip_hash text,
  messages jsonb not null default '[]'::jsonb,
  lead_inquiry_id uuid references public.builder_inquiries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, session_id)
);
create index if not exists builder_ai_chats_tenant_idx on public.builder_ai_chats (tenant_id, updated_at desc);

alter table public.builder_ai_chats enable row level security;
revoke all on table public.builder_ai_chats from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_ai_chats to service_role;
