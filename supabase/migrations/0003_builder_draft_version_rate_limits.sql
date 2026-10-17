-- 1) 草稿樂觀鎖：version 欄位，每次寫入 +1（條件更新由應用層以 eq(version) 做）
alter table public.builder_site_drafts add column if not exists version integer not null default 1;

-- 2) 發布：凍結「指定版本」的草稿；版本不符就拒絕（避免驗證與凍結的不是同一份草稿）
drop function if exists public.builder_publish(uuid, text, text);
create or replace function public.builder_publish(p_tenant uuid, p_note text, p_actor text, p_expected_draft_version integer)
returns table (revision_id uuid, revision_number integer, draft_version integer)
language plpgsql
set search_path = public
as $$
declare
  v_content jsonb;
  v_version integer;
  v_number integer;
  v_id uuid;
begin
  perform 1 from public.builder_tenants where id = p_tenant for update;
  if not found then
    raise exception 'builder: tenant % not found', p_tenant;
  end if;
  select d.content, d.version into v_content, v_version
    from public.builder_site_drafts d where d.tenant_id = p_tenant for update;
  if v_content is null then
    raise exception 'builder: draft for tenant % not found', p_tenant;
  end if;
  if p_expected_draft_version is not null and v_version <> p_expected_draft_version then
    raise exception 'builder: draft version mismatch (expected %, current %)', p_expected_draft_version, v_version;
  end if;
  select coalesce(max(r.number), 0) + 1 into v_number
    from public.builder_site_revisions r where r.tenant_id = p_tenant;
  insert into public.builder_site_revisions (tenant_id, number, content, note, published_by)
    values (p_tenant, v_number, v_content, p_note, p_actor)
    returning id into v_id;
  update public.builder_tenants
     set published_revision_id = v_id,
         theme = coalesce(v_content -> 'theme', '{}'::jsonb)
   where id = p_tenant;
  return query select v_id, v_number, v_version;
end;
$$;

-- 3) 還原：覆蓋草稿時版本 +1（讓還原前讀到的舊草稿無法再寫回）
create or replace function public.builder_rollback(p_tenant uuid, p_number integer, p_actor text)
returns table (revision_id uuid, revision_number integer)
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_content jsonb;
begin
  perform 1 from public.builder_tenants where id = p_tenant for update;
  if not found then
    raise exception 'builder: tenant % not found', p_tenant;
  end if;
  select r.id, r.content into v_id, v_content
    from public.builder_site_revisions r
   where r.tenant_id = p_tenant and r.number = p_number;
  if v_id is null then
    return;
  end if;
  update public.builder_tenants
     set published_revision_id = v_id,
         theme = coalesce(v_content -> 'theme', '{}'::jsonb)
   where id = p_tenant;
  insert into public.builder_site_drafts (tenant_id, content, updated_at, updated_by, version)
    values (p_tenant, v_content, now(), p_actor, 1)
    on conflict (tenant_id) do update
      set content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
          version = public.builder_site_drafts.version + 1;
  return query select v_id, p_number;
end;
$$;

-- 4) 原子限流：固定時間窗計數，insert … on conflict … returning 一次完成（跨 serverless 實例有效）
create table if not exists public.builder_rate_limits (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, key, window_start)
);
alter table public.builder_rate_limits enable row level security;
revoke all on table public.builder_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.builder_rate_limits to service_role;

create or replace function public.builder_rate_hit(p_bucket text, p_key text, p_window_seconds integer, p_limit integer)
returns table (hit_count integer, allowed boolean)
language plpgsql
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.builder_rate_limits as rl (bucket, key, window_start, count)
    values (p_bucket, p_key, v_window, 1)
    on conflict (bucket, key, window_start) do update set count = rl.count + 1
    returning rl.count into v_count;
  -- 偶爾清掉舊的時間窗
  if random() < 0.02 then
    delete from public.builder_rate_limits where window_start < now() - interval '2 days';
  end if;
  return query select v_count, v_count <= p_limit;
end;
$$;

revoke all on function public.builder_publish(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.builder_rollback(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.builder_rate_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.builder_publish(uuid, text, text, integer) to service_role;
grant execute on function public.builder_rollback(uuid, integer, text) to service_role;
grant execute on function public.builder_rate_hit(text, text, integer, integer) to service_role;
