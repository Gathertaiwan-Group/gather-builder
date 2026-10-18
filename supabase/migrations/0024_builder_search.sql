-- 第六批：search（站內搜尋）。
-- 🔴 共用專案：只新增函式（builder_ 前綴、固定 search_path、只給 service_role）。不新增任何 extension（不用 pg_trgm）。
-- 用 strpos(lower(欄位), lower(關鍵字)) 做片語比對：中文可搜、沒有 LIKE 萬用字元注入問題。
-- 只搜「該租戶」「已發布」的內容；課程只搜課程介紹與單元標題，🔴 絕不搜單元內文（付費內容）。
-- p_lang（非預設語言）時另外比對「已發布」的翻譯。directory／downloads 模組的 migration 會擴充這個函式。

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
