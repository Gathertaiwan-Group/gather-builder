-- 新版已部署：移除 0004 的過渡用 3 參數 builder_publish（不檢查草稿版本，不再保留）。
drop function if exists public.builder_publish(uuid, text, text);
