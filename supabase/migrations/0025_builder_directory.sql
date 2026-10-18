-- 第六批：directory（人員名錄）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 聯絡方式（email／電話／網站）預設不公開：show_contact = true 才顯示在前台。搜尋函式加入已發布人員（簽章不變）。

create table if not exists public.builder_people (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  name text not null check (char_length(name) between 1 and 80),
  title text check (title is null or char_length(title) <= 120),
  category text check (category is null or char_length(category) <= 40),
  photo_url text,
  bio_md text not null default '',
  email text,
  phone text,
  website text,
  show_contact boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'published')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists builder_people_tenant_idx on public.builder_people (tenant_id, status, sort);

alter table public.builder_people enable row level security;
revoke all on table public.builder_people from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_people to service_role;

create or replace function public.builder_search_content(p_tenant uuid, p_q text, p_lang text, p_limit integer)
returns table (kind text, id uuid, slug text, title text, body text, rank integer)
language plpgsql
stable
set search_path = public
as $$
declare
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_lim integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  if char_length(v_q) < 1 or char_length(v_q) > 60 then
    return;
  end if;
  return query
  with hits as (
    select 'post'::text as kind, p.id, p.slug, p.title, coalesce(p.excerpt, '') || E'\n' || p.body_md as body,
           case when strpos(lower(p.title), v_q) > 0 then 2 else 1 end as rank, p.published_at as at
      from public.builder_posts p
     where p.tenant_id = p_tenant and p.status = 'published' and p.published_at is not null and p.published_at <= now()
       and (strpos(lower(p.title), v_q) > 0 or strpos(lower(coalesce(p.excerpt, '')), v_q) > 0 or strpos(lower(p.body_md), v_q) > 0)
    union all
    select 'product', pr.id, pr.slug, pr.name, pr.description_md,
           case when strpos(lower(pr.name), v_q) > 0 then 2 else 1 end, pr.updated_at
      from public.builder_products pr
     where pr.tenant_id = p_tenant and pr.status = 'published'
       and (strpos(lower(pr.name), v_q) > 0 or strpos(lower(pr.description_md), v_q) > 0)
    union all
    select 'event', e.id, e.slug, e.title, coalesce(e.summary, '') || E'\n' || e.body_md,
           case when strpos(lower(e.title), v_q) > 0 then 2 else 1 end, e.updated_at
      from public.builder_events e
     where e.tenant_id = p_tenant and e.status = 'published'
       and (strpos(lower(e.title), v_q) > 0 or strpos(lower(coalesce(e.summary, '')), v_q) > 0 or strpos(lower(e.body_md), v_q) > 0)
    union all
    -- 課程：課程介紹（公開）＋已發布單元的「標題」（公開列在課程頁）；單元內文不搜
    select 'course', c.id, c.slug, c.title, coalesce(c.summary, '') || E'\n' || c.body_md,
           case when strpos(lower(c.title), v_q) > 0 then 2 else 1 end, c.updated_at
      from public.builder_courses c
     where c.tenant_id = p_tenant and c.status = 'published'
       and (strpos(lower(c.title), v_q) > 0 or strpos(lower(coalesce(c.summary, '')), v_q) > 0 or strpos(lower(c.body_md), v_q) > 0
            or exists (select 1 from public.builder_course_lessons l
                        where l.course_id = c.id and l.status = 'published' and strpos(lower(l.title), v_q) > 0))
    union all
    -- 人員名錄（已發布）：姓名、職稱、分類、簡介
    select 'person', pe.id, pe.slug, pe.name, coalesce(pe.title, '') || E'\n' || coalesce(pe.category, '') || E'\n' || pe.bio_md,
           case when strpos(lower(pe.name), v_q) > 0 then 2 else 1 end, pe.updated_at
      from public.builder_people pe
     where pe.tenant_id = p_tenant and pe.status = 'published'
       and (strpos(lower(pe.name), v_q) > 0 or strpos(lower(coalesce(pe.title, '')), v_q) > 0 or strpos(lower(coalesce(pe.category, '')), v_q) > 0 or strpos(lower(pe.bio_md), v_q) > 0)
    union all
    -- 已發布的翻譯（外文網址搜外文）
    select t.entity_type, t.entity_id, null::text, null::text, t.published_value, 1, t.published_at
      from public.builder_translations t
     where p_lang is not null and t.tenant_id = p_tenant and t.lang = p_lang and t.published_value is not null
       and strpos(lower(t.published_value), v_q) > 0
  )
  select h.kind, h.id, h.slug, h.title, left(h.body, 4000), h.rank from hits h
   order by h.rank desc, h.at desc nulls last
   limit v_lim * 2;
end;
$$;

revoke all on function public.builder_search_content(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.builder_search_content(uuid, text, text, integer) to service_role;
