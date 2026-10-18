-- 第三批獨立審查修正（2026-10-19）。
-- 🔴 共用專案：只動 builder_ 物件；RLS 維持開啟且不建 policy；只 grant 給 service_role。
-- 相容性：只加欄位／放寬 check／新函式，舊版程式照常運作（先 migrate 再 push）。

-- L-1：分潤帳只增不改——明確收回 service_role 的 update／delete／truncate（只留 select、insert）
revoke update, delete, truncate on table public.builder_referral_ledger from service_role;

-- H-1：推薦回饋可撤銷（被推薦人訂單取消 → 停用回饋券並撤銷，冪等）
alter table public.builder_referrals add column if not exists revoked_at timestamptz;
alter table public.builder_referrals add column if not exists revoked_reason text;
create index if not exists builder_referrals_referrer_idx on public.builder_referrals (tenant_id, referrer_member_id, created_at);
create index if not exists builder_referrals_order_idx on public.builder_referrals (order_id);

-- M-1：群發寄送列先原子宣告（queued → sending）再寄，併發不會重寄
alter table public.builder_newsletter_deliveries drop constraint if exists builder_newsletter_deliveries_status_check;
alter table public.builder_newsletter_deliveries add constraint builder_newsletter_deliveries_status_check
  check (status in ('queued', 'sending', 'sent', 'failed', 'skipped'));
alter table public.builder_newsletter_deliveries add column if not exists claimed_at timestamptz;

-- 宣告一批：FOR UPDATE SKIP LOCKED，兩個併發呼叫拿到的列不重疊
create or replace function public.builder_claim_deliveries(p_tenant uuid, p_broadcast uuid, p_limit integer)
returns setof public.builder_newsletter_deliveries
language plpgsql
set search_path = public
as $$
begin
  return query
  update public.builder_newsletter_deliveries d
     set status = 'sending', claimed_at = now()
   where d.id in (
     select x.id from public.builder_newsletter_deliveries x
      where x.tenant_id = p_tenant and x.broadcast_id = p_broadcast and x.status = 'queued'
      order by x.created_at, x.id
      limit greatest(1, least(p_limit, 200))
      for update skip locked
   )
  returning d.*;
end;
$$;

-- 宣告後行程中斷（寄了沒有不知道）的列：不重寄，標 failed 讓人工判斷
create or replace function public.builder_fail_stale_deliveries(p_tenant uuid, p_broadcast uuid, p_before timestamptz)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.builder_newsletter_deliveries
     set status = 'failed', error = '寄送狀態不明（宣告後中斷），為避免重複寄送未重寄'
   where tenant_id = p_tenant and broadcast_id = p_broadcast and status = 'sending' and claimed_at < p_before;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.builder_claim_deliveries(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.builder_fail_stale_deliveries(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.builder_claim_deliveries(uuid, uuid, integer) to service_role;
grant execute on function public.builder_fail_stale_deliveries(uuid, uuid, timestamptz) to service_role;
