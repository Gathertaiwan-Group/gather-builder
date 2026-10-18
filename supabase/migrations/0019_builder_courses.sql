-- 第四批：courses（線上課程）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 開通（entitlement）：同一會員同一課程只有一列（unique），付款成功 hook 冪等開通、訂單取消冪等撤銷。

create table if not exists public.builder_courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  title text not null check (char_length(title) between 1 and 160),
  summary text,
  body_md text not null default '',
  cover_url text,
  -- 0 = 免費課程（登入會員即可加入）
  price integer not null default 0 check (price between 0 and 1000000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table if not exists public.builder_course_lessons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  course_id uuid not null references public.builder_courses(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  title text not null check (char_length(title) between 1 and 160),
  -- 嵌入網址（只允許 YouTube／Vimeo 白名單，已正規化成 embed 網址）；未開通者的 HTML 一律不輸出
  video_url text,
  body_md text not null default '',
  -- [{ name, url }]（https），未開通者看不到
  attachments jsonb not null default '[]'::jsonb,
  is_preview boolean not null default false,
  status text not null default 'published' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, slug)
);
create index if not exists builder_course_lessons_course_idx on public.builder_course_lessons (course_id, sort);

create table if not exists public.builder_course_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  course_id uuid not null references public.builder_courses(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  source text not null check (source in ('order', 'manual', 'free')),
  order_id uuid references public.builder_orders(id) on delete set null,
  granted_at timestamptz not null default now(),
  granted_by text,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, course_id, member_id)
);
create index if not exists builder_course_enrollments_order_idx on public.builder_course_enrollments (order_id);
create index if not exists builder_course_enrollments_member_idx on public.builder_course_enrollments (member_id);

create table if not exists public.builder_course_progress (
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  course_id uuid not null references public.builder_courses(id) on delete cascade,
  lesson_id uuid not null references public.builder_course_lessons(id) on delete cascade,
  member_id uuid not null references public.builder_members(id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (member_id, lesson_id)
);
create index if not exists builder_course_progress_course_idx on public.builder_course_progress (member_id, course_id);

alter table public.builder_courses enable row level security;
alter table public.builder_course_lessons enable row level security;
alter table public.builder_course_enrollments enable row level security;
alter table public.builder_course_progress enable row level security;
revoke all on table public.builder_courses, public.builder_course_lessons, public.builder_course_enrollments, public.builder_course_progress from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_courses, public.builder_course_lessons, public.builder_course_enrollments, public.builder_course_progress to service_role;

-- 開通（冪等）：沒有列 → 新增；已撤銷 → 重新開通；已開通 → 不動（回 granted=false）。併發只會有一筆「真的開通」。
create or replace function public.builder_grant_enrollment(p_tenant uuid, p_course uuid, p_member uuid, p_source text, p_order uuid, p_by text)
returns table (enrollment_id uuid, granted boolean)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_id uuid;
begin
  insert into public.builder_course_enrollments as e (tenant_id, course_id, member_id, status, source, order_id, granted_by)
  values (p_tenant, p_course, p_member, 'active', p_source, p_order, p_by)
  on conflict (tenant_id, course_id, member_id) do update
     set status = 'active', source = excluded.source, order_id = excluded.order_id, granted_at = now(), granted_by = excluded.granted_by,
         revoked_at = null, revoked_by = null, revoke_reason = null, updated_at = now()
   where e.status = 'revoked'
  returning e.id into v_id;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  select id into v_id from public.builder_course_enrollments where tenant_id = p_tenant and course_id = p_course and member_id = p_member;
  return query select v_id, false;
end;
$$;

revoke all on function public.builder_grant_enrollment(uuid, uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.builder_grant_enrollment(uuid, uuid, uuid, text, uuid, text) to service_role;
