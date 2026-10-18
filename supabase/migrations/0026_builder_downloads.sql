-- 第六批：downloads（文件下載）。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role、函式固定 search_path。
-- 檔案放私有 bucket builder-downloads（scripts/ensure-buckets.mjs 以 Storage API 建立），物件路徑 <tenant_id>/<document_id>/<淨化後檔名>；
-- 下載一律走 60 秒簽名網址（公開文件也是，方便統計）；限會員的文件在 server 端檢查會員 session。

create table if not exists public.builder_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  category text check (category is null or char_length(category) <= 40),
  description text check (description is null or char_length(description) <= 1000),
  -- 物件路徑一定在自己的租戶資料夾底下
  file_path text check (file_path is null or file_path like tenant_id::text || '/%'),
  file_name text check (file_name is null or char_length(file_name) <= 160),
  content_type text,
  size_bytes integer check (size_bytes is null or size_bytes between 0 and 52428800),
  visibility text not null default 'public' check (visibility in ('public', 'members')),
  -- uploading＝已發簽名上傳網址、尚未確認檔案；draft／published
  status text not null default 'uploading' check (status in ('uploading', 'draft', 'published')),
  download_count integer not null default 0 check (download_count >= 0),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists builder_documents_tenant_idx on public.builder_documents (tenant_id, status, sort);

alter table public.builder_documents enable row level security;
revoke all on table public.builder_documents from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_documents to service_role;

-- 下載次數（原子 +1）
create or replace function public.builder_bump_download(p_tenant uuid, p_doc uuid)
returns integer
language sql
set search_path = public
as $$
  update public.builder_documents set download_count = download_count + 1
   where id = p_doc and tenant_id = p_tenant and status = 'published'
  returning download_count;
$$;
revoke all on function public.builder_bump_download(uuid, uuid) from public, anon, authenticated;
grant execute on function public.builder_bump_download(uuid, uuid) to service_role;

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
    -- 文件（已發布且公開；限會員的文件不出現在搜尋）
    select 'document', d.id, null::text, d.title, coalesce(d.category, '') || E'\n' || coalesce(d.description, ''),
           case when strpos(lower(d.title), v_q) > 0 then 2 else 1 end, d.updated_at
      from public.builder_documents d
     where d.tenant_id = p_tenant and d.status = 'published' and d.visibility = 'public'
       and (strpos(lower(d.title), v_q) > 0 or strpos(lower(coalesce(d.description, '')), v_q) > 0 or strpos(lower(coalesce(d.category, '')), v_q) > 0)
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
