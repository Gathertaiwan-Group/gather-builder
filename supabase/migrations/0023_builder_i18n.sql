-- 第六批：i18n（多語＋AI 翻譯）。頁面翻譯存在草稿／快照（content.translations），跟著 publish_site 上線；
-- 文章／商品／活動／課程（模組資料，不在快照）的翻譯存這張表：draft_value（AI 或手動草稿）→ publish_translations 才複製到 published_value。
-- 🔴 共用專案：builder_ 前綴、放 public、RLS 開且不建 policy、只 grant 給 service_role。

create table if not exists public.builder_translations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.builder_tenants(id) on delete cascade,
  entity_type text not null check (entity_type in ('post', 'product', 'event', 'course')),
  entity_id uuid not null,
  lang text not null check (lang ~ '^[a-z]{2}(-[a-z]{2})?$'),
  -- 只允許內容欄位（title／name／excerpt／summary／body_md／description_md）；slug、價格、id 不翻譯
  field text not null check (field in ('title', 'name', 'excerpt', 'summary', 'body_md', 'description_md')),
  draft_value text check (draft_value is null or char_length(draft_value) <= 100000),
  draft_ai boolean not null default false,
  draft_updated_at timestamptz,
  published_value text check (published_value is null or char_length(published_value) <= 100000),
  published_ai boolean not null default false,
  published_at timestamptz,
  updated_by text,
  unique (tenant_id, entity_type, entity_id, lang, field)
);
create index if not exists builder_translations_lookup_idx on public.builder_translations (tenant_id, lang, entity_type, entity_id);

alter table public.builder_translations enable row level security;
revoke all on table public.builder_translations from public, anon, authenticated;
grant select, insert, update, delete on table public.builder_translations to service_role;
