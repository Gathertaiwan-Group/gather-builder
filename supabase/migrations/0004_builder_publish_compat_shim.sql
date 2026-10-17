-- 過渡用：舊版程式（部署切換期間）仍呼叫 3 參數的 builder_publish。新版部署完成後由 0005 移除。
create or replace function public.builder_publish(p_tenant uuid, p_note text, p_actor text)
returns table (revision_id uuid, revision_number integer, draft_version integer)
language sql
set search_path = public
as $$ select * from public.builder_publish(p_tenant, p_note, p_actor, null::integer) $$;
revoke all on function public.builder_publish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.builder_publish(uuid, text, text) to service_role;
