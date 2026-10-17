-- 這個專案新建表不會自動 grant 給 API 角色：明確只給 service_role（anon/authenticated 維持無權限）。
grant select, insert, update, delete on table
  public.builder_tenants, public.builder_tenant_modules, public.builder_site_drafts,
  public.builder_site_revisions, public.builder_posts, public.builder_portfolio_items,
  public.builder_inquiries, public.builder_line_clicks, public.builder_api_tokens,
  public.builder_audit_log
  to service_role;
grant usage, select on sequence public.builder_line_clicks_id_seq, public.builder_audit_log_id_seq to service_role;
