-- 第六批：announcements（公告）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role。
-- 必讀確認紀錄只增不改：service_role 只有 select／insert（update／delete／truncate 收回），unique(公告, 會員) 只記第一次確認。

create table if not exists public.builder_announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  body_md text not null default '' check (char_length(body_md) <= 20000),
  pinned boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  -- all 所有訪客／members 僅登入會員
  audience text not null default 'all' check (audience in ('all', 'members')),
  -- 必讀：會員登入後要按「確認」（只對會員有意義）
  require_ack boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index if not exists builder_announcements_tenant_idx on public.builder_announcements (tenant_id, status, pinned desc, starts_at desc);

create table if not exists public.builder_announcement_acks (
  id bigserial primary key,
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  announcement_id uuid not null references public.builder_announcements(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  acked_at timestamptz not null default now(),
  unique (announcement_id, member_id)
);
create index if not exists builder_announcement_acks_member_idx on public.builder_announcement_acks (tenant_id, member_id);

alter table public.builder_announcements enable row level security;
alter table public.builder_announcement_acks enable row level security;
revoke all on table public.builder_announcements, public.builder_announcement_acks from public, anon, authenticated;
revoke all on sequence public.builder_announcement_acks_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_announcements to service_role;
grant select, insert on table public.builder_announcement_acks to service_role;
revoke update, delete, truncate on table public.builder_announcement_acks from service_role;
grant usage on sequence public.builder_announcement_acks_id_seq to service_role;
