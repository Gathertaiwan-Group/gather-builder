-- 第九批獨立審查修正。
-- 🔴 共用專案：只動 builder_ 物件；RLS 開且不建 policy；只 grant 給 service_role；函式固定 search_path。

-- M1：自有網域所有權驗證——每個租戶×網域一組專屬 TXT token（_gather-verify.<網域> = gather-verify=<token>）
alter table public.builder_tenant_domains add column if not exists verify_token text;
update public.builder_tenant_domains set verify_token = md5(random()::text || clock_timestamp()::text || id::text) where verify_token is null;
alter table public.builder_tenant_domains alter column verify_token set not null;

-- M1：移除網域的冷卻期（7 天內只有原租戶能再加回）
create table if not exists public.builder_domain_releases (
  id bigserial primary key,
  domain text not null,
  tenant_id uuid not null,
  reason text not null check (reason in ('removed', 'expired')),
  released_at timestamptz not null default now()
);
create index if not exists builder_domain_releases_domain_idx on public.builder_domain_releases (domain, released_at desc);
alter table public.builder_domain_releases enable row level security;
revoke all on table public.builder_domain_releases from public, anon, authenticated;
revoke all on sequence public.builder_domain_releases_id_seq from public, anon, authenticated;
grant select, insert on table public.builder_domain_releases to service_role;
revoke update, delete, truncate on table public.builder_domain_releases from service_role;
grant usage on sequence public.builder_domain_releases_id_seq to service_role;

-- M2：逾期後才付款、網址代號已被占用 → paid_needs_attention（已收款、需人工處理；不在 live_slug 唯一索引內）
alter table public.builder_platform_orders drop constraint if exists builder_platform_orders_status_check;
alter table public.builder_platform_orders add constraint builder_platform_orders_status_check
  check (status in ('pending_payment', 'paid', 'expired', 'cancelled', 'paid_needs_attention'));

-- L7：TOTP 一次性復原碼（只存 sha256）
alter table public.builder_owner_users add column if not exists totp_recovery_hashes text[] not null default '{}';
create or replace function public.builder_owner_use_recovery(p_user uuid, p_hash text)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.builder_owner_users
     set totp_recovery_hashes = array_remove(totp_recovery_hashes, p_hash), updated_at = now()
   where id = p_user and p_hash = any(totp_recovery_hashes);
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;
revoke all on function public.builder_owner_use_recovery(uuid, text) from public, anon, authenticated;
grant execute on function public.builder_owner_use_recovery(uuid, text) to service_role;

-- L10：手動 MCP token 記錄建立者（停用／降級成員時可一鍵撤銷他建立的 token）
alter table public.builder_api_tokens add column if not exists created_by text check (created_by is null or char_length(created_by) <= 200);

-- L13：授權請求沒帶 redirect_uri（client 只註冊一個、由伺服器帶入）時，token 端點也允許不帶
alter table public.builder_oauth_codes add column if not exists redirect_explicit boolean not null default true;
