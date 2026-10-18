import { z } from "zod";
import type { LoadedSite } from "../site-loader";
import type { Store, TenantRow, TrEntityType, TranslationRow } from "../store/types";
import type { SiteContent } from "../content";
import { i18nSettings, type I18nSettings } from "@/modules/i18n/manifest";
import { DEFAULT_LANG, isLangCode, type LangCode } from "../i18n/langs";
import { translatableFields } from "../i18n/translatable";
import { geminiTranslatorFromEnv, mockTranslator, sanitizeTranslation, type Translator } from "../ai/translate";
import { ServiceError, activeModuleIds, audit, loadDraft, moduleStates, mutateDraft, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { taipeiDay } from "./shop";

/* ================================================================== 共用 */

/** 模組資料可翻譯的欄位（slug、價格、id 不在裡面） */
export const ENTITY_FIELDS: Record<TrEntityType, string[]> = {
  post: ["title", "excerpt", "body_md"],
  product: ["name", "description_md"],
  event: ["title", "summary", "body_md"],
  course: ["title", "summary", "body_md"],
};
export const DEFAULT_AI_DAILY_LIMIT = 50;
export const AI_PER_MINUTE = 6;

export const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), path: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal("nav") }).strict(),
  z.object({ type: z.enum(["post", "product", "event", "course"]), id: z.string().trim().max(64).optional(), slug: z.string().trim().max(80).optional() }).strict(),
]);
export type TranslateTarget = z.output<typeof targetSchema>;

async function requireI18n(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("i18n")) throw new ServiceError("forbidden", "此網站未啟用模組「i18n」，請先 enable_module i18n");
}

/** 語言必須已在草稿或已發布的 i18n 設定中開啟 */
async function requireLang(ctx: ServiceContext, tenant: TenantRow, lang: unknown): Promise<LangCode> {
  if (!isLangCode(lang)) throw new ServiceError("invalid", "不支援的語言代碼");
  const draft = i18nSettings.safeParse((await loadDraft(ctx, tenant)).moduleSettings?.i18n ?? {});
  const pub = (await publishedModuleSettings(ctx.store, tenant, "i18n")) as Partial<I18nSettings>;
  const langs = new Set([...(draft.success ? draft.data.languages : []), ...(pub.languages ?? [])]);
  if (!langs.has(lang)) throw new ServiceError("invalid", `語言「${lang}」尚未開啟：請先 configure_module i18n { languages: ["${lang}"] }`);
  return lang;
}

async function findEntity(store: Store, tenantId: string, t: { type: TrEntityType; id?: string; slug?: string }): Promise<{ id: string; values: Record<string, string> }> {
  const pick = (row: object | null) => {
    if (!row) throw new ServiceError("not_found", `找不到要翻譯的${t.type}（請給 id 或 slug）`);
    const r = row as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const f of ENTITY_FIELDS[t.type]) if (typeof r[f] === "string" && (r[f] as string).trim()) values[f] = r[f] as string;
    return { id: r.id as string, values };
  };
  if (t.type === "post") return pick(t.id ? await store.getPostById(tenantId, t.id) : t.slug ? await store.getPostBySlug(tenantId, t.slug) : null);
  if (t.type === "product") return pick(t.id ? await store.getProductById(tenantId, t.id) : t.slug ? await store.getProductBySlug(tenantId, t.slug) : null);
  if (t.type === "event") return pick(t.id ? await store.getEventById(tenantId, t.id) : t.slug ? await store.getEventBySlug(tenantId, t.slug) : null);
  return pick(t.id ? await store.getCourseById(tenantId, t.id) : t.slug ? await store.getCourseBySlug(tenantId, t.slug) : null);
}

/** 頁面可翻譯的原文：title、seoTitle、seoDescription、s.<區塊 id>.<欄位路徑> */
export function pageSourceFields(content: SiteContent, path: string): Record<string, string> {
  const page = content.pages.find((p) => p.path === path);
  if (!page) throw new ServiceError("not_found", `找不到頁面 ${path}`);
  const out: Record<string, string> = { title: page.title };
  if (page.seo?.title) out.seoTitle = page.seo.title;
  if (page.seo?.description) out.seoDescription = page.seo.description;
  for (const s of page.sections) for (const [k, v] of Object.entries(translatableFields(s.props))) out[`s.${s.id}.${k}`] = v;
  return out;
}
export function navSourceFields(content: SiteContent): Record<string, string> {
  return Object.fromEntries(content.nav.map((n, i) => [`nav.${i}`, n.label]));
}

/** 已存在的翻譯（頁面：草稿內容；模組資料：草稿值）→ { key: { t, ai } } */
function existingPageTr(content: SiteContent, lang: string, path: string): Record<string, { t: string; ai?: boolean }> {
  const tr = content.translations?.[lang]?.pages?.[path];
  const out: Record<string, { t: string; ai?: boolean }> = {};
  if (!tr) return out;
  if (tr.title) out.title = tr.title;
  if (tr.seoTitle) out.seoTitle = tr.seoTitle;
  if (tr.seoDescription) out.seoDescription = tr.seoDescription;
  for (const [sid, fields] of Object.entries(tr.sections ?? {})) for (const [k, v] of Object.entries(fields)) out[`s.${sid}.${k}`] = v;
  return out;
}

/** 把 { key: 譯文 } 寫進草稿 content.translations（只寫原文存在的 key；ai 旗標） */
function writePageTr(d: SiteContent, lang: string, path: string, values: Record<string, string | null>, ai: boolean, source: Record<string, string>) {
  d.translations ??= {};
  const L = (d.translations[lang] ??= { pages: {}, nav: {} });
  L.pages ??= {};
  L.nav ??= {};
  const P = (L.pages[path] ??= { sections: {} });
  P.sections ??= {};
  for (const [k, v] of Object.entries(values)) {
    if (!(k in source)) continue;
    const entry = v === null ? undefined : { t: v, ...(ai ? { ai: true } : {}) };
    if (k === "title" || k === "seoTitle" || k === "seoDescription") {
      if (entry) P[k] = entry;
      else delete P[k];
      continue;
    }
    const m = /^s\.(s_[a-z0-9]{6,16})\.(.+)$/.exec(k);
    if (!m) continue;
    const sec = (P.sections[m[1]!] ??= {});
    if (entry) sec[m[2]!] = entry;
    else delete sec[m[2]!];
    if (!Object.keys(sec).length) delete P.sections[m[1]!];
  }
}
function writeNavTr(d: SiteContent, lang: string, values: Record<string, string | null>, ai: boolean, source: Record<string, string>) {
  d.translations ??= {};
  const L = (d.translations[lang] ??= { pages: {}, nav: {} });
  L.nav ??= {};
  L.pages ??= {};
  for (const [k, v] of Object.entries(values)) {
    if (!(k in source)) continue;
    const i = k.slice(4);
    if (v === null) delete L.nav[i];
    else L.nav[i] = { t: v, ...(ai ? { ai: true } : {}) };
  }
}

/* ================================================================== AI 翻譯 */

export type TranslatorFactory = (tenant: TenantRow) => Translator | null;
/** 正式：平台 GEMINI_API_KEY；沒有 key 時只有 is_test 網站用 mock（e2e） */
export const defaultTranslatorFactory: TranslatorFactory = (tenant) => geminiTranslatorFromEnv() ?? (tenant.is_test ? mockTranslator : null);

/**
 * AI 翻譯一個目標（頁面／導覽／一筆文章、商品、活動、課程）：
 * - 只送「可翻譯欄位」給 AI，回來的 key 只採用送出去的（sanitizeTranslation）；
 * - 結果一律進**草稿**並標記 ai（頁面：草稿 content.translations，publish_site 才上線；模組資料：draft_value，publish_translations 才上線）；
 * - 預設不覆蓋店主手動改過（ai=false）的翻譯；overwrite: true 才全部重翻；
 * - 限流（DB 原子 builder_rate_hit）：每租戶每日 aiDailyLimit（預設 50）＋每分鐘 6 次。被擋不呼叫 AI。
 */
export async function translateContent(
  ctx: ServiceContext,
  input: { site?: string | null; lang: string; target: unknown; overwrite?: boolean },
  factory: TranslatorFactory = defaultTranslatorFactory,
) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireI18n(ctx, tenant);
  const lang = await requireLang(ctx, tenant, input.lang);
  const target = parse(targetSchema, input.target);
  const translator = factory(tenant);
  if (!translator) throw new ServiceError("invalid", "平台尚未設定 AI 翻譯（GEMINI_API_KEY），目前只能用 set_translation 手動翻譯");
  const draft = await loadDraft(ctx, tenant);
  const settings = i18nSettings.safeParse(draft.moduleSettings?.i18n ?? {});
  const limit = (settings.success ? settings.data.aiDailyLimit : undefined) ?? DEFAULT_AI_DAILY_LIMIT;

  let source: Record<string, string>;
  let existing: Record<string, { t: string; ai?: boolean }>;
  let entity: { id: string; values: Record<string, string> } | null = null;
  if (target.type === "page") {
    source = pageSourceFields(draft, target.path);
    existing = existingPageTr(draft, lang, target.path);
  } else if (target.type === "nav") {
    source = navSourceFields(draft);
    existing = Object.fromEntries(Object.entries(draft.translations?.[lang]?.nav ?? {}).map(([i, v]) => [`nav.${i}`, v]));
  } else {
    entity = await findEntity(ctx.store, tenant.id, target);
    source = entity.values;
    const rows = await ctx.store.listTranslations(tenant.id, { lang, entityType: target.type, entityIds: [entity.id] });
    existing = Object.fromEntries(rows.filter((r) => r.draft_value !== null).map((r) => [r.field, { t: r.draft_value!, ai: r.draft_ai }]));
  }
  const toSend = Object.fromEntries(Object.entries(source).filter(([k]) => input.overwrite || !existing[k] || existing[k]!.ai));
  if (!Object.keys(toSend).length) return { lang, target, translated: 0, skippedManual: Object.keys(source).length, draft: true, note: "沒有需要翻譯的欄位（店主手動翻譯過的欄位預設不覆蓋，要重翻請帶 overwrite: true）。" };

  const day = await ctx.store.rateHit(`i18n-ai-day:${tenant.id}`, taipeiDay(), 86400, limit);
  if (!day.allowed) throw new ServiceError("rate_limited", `今天的 AI 翻譯次數已達上限（${limit} 次），明天再試或用 set_translation 手動翻譯`);
  const minute = await ctx.store.rateHit(`i18n-ai-min:${tenant.id}`, "all", 60, AI_PER_MINUTE);
  if (!minute.allowed) throw new ServiceError("rate_limited", "AI 翻譯太頻繁，請一分鐘後再試");

  let result: Record<string, string>;
  try {
    result = sanitizeTranslation(toSend, await translator({ lang, fields: toSend, glossary: settings.success ? settings.data.glossary : undefined, siteName: tenant.name }));
  } catch (e) {
    console.error("[i18n] AI 翻譯失敗", e instanceof Error ? e.message : e);
    throw new ServiceError("invalid", "AI 翻譯暫時失敗，請稍後再試");
  }
  if (target.type === "page") {
    await mutateDraft(ctx, tenant, (d) => writePageTr(d, lang, target.path, result, true, pageSourceFields(d, target.path)));
  } else if (target.type === "nav") {
    await mutateDraft(ctx, tenant, (d) => writeNavTr(d, lang, result, true, navSourceFields(d)));
  } else {
    await ctx.store.upsertTranslationDrafts(Object.entries(result).map(([field, v]) => ({ tenant_id: tenant.id, entity_type: target.type, entity_id: entity!.id, lang, field, draft_value: v, draft_ai: true, updated_by: ctx.actor.label })));
  }
  await audit(ctx, tenant.id, "i18n.ai_translate", { lang, target, fields: Object.keys(result).length });
  const missing = Object.keys(toSend).filter((k) => !(k in result));
  return {
    lang,
    target,
    translated: Object.keys(result).length,
    missing,
    draft: true,
    preview: Object.fromEntries(Object.entries(result).slice(0, 8).map(([k, v]) => [k, v.slice(0, 200)])),
    note:
      target.type === "page" || target.type === "nav"
        ? "AI 翻譯已存入草稿（標記 AI 翻譯），店主可用 set_translation 修改；preview_changes → publish_site 後才上線。"
        : "AI 翻譯已存入草稿（標記 AI 翻譯），店主可用 set_translation 修改；publish_translations（confirm）後才上線。",
  };
}

/** 手動翻譯／修改 AI 翻譯（ai 旗標變 false）；值為 null＝刪除該欄翻譯（顯示回中文） */
export async function setTranslation(ctx: ServiceContext, input: { site?: string | null; lang: string; target: unknown; fields: Record<string, string | null> }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireI18n(ctx, tenant);
  const lang = await requireLang(ctx, tenant, input.lang);
  const target = parse(targetSchema, input.target);
  const fields = parse(z.record(z.string().max(200), z.string().max(20_000).nullable()), input.fields);
  let unknown: string[] = [];
  if (target.type === "page" || target.type === "nav") {
    await mutateDraft(ctx, tenant, (d) => {
      const src = target.type === "page" ? pageSourceFields(d, target.path) : navSourceFields(d);
      unknown = Object.keys(fields).filter((k) => !(k in src));
      if (unknown.length) throw new ServiceError("invalid", `這些欄位不能翻譯（不存在或是比對鍵／網址）：${unknown.join("、")}`);
      if (target.type === "page") writePageTr(d, lang, target.path, fields, false, src);
      else writeNavTr(d, lang, fields, false, src);
    });
  } else {
    const e = await findEntity(ctx.store, tenant.id, target);
    unknown = Object.keys(fields).filter((k) => !ENTITY_FIELDS[target.type].includes(k));
    if (unknown.length) throw new ServiceError("invalid", `這些欄位不能翻譯：${unknown.join("、")}（可翻譯：${ENTITY_FIELDS[target.type].join("、")}）`);
    await ctx.store.upsertTranslationDrafts(Object.entries(fields).map(([field, v]) => ({ tenant_id: tenant.id, entity_type: target.type, entity_id: e.id, lang, field, draft_value: v, draft_ai: false, updated_by: ctx.actor.label })));
  }
  await audit(ctx, tenant.id, "i18n.set", { lang, target, fields: Object.keys(fields) });
  return { lang, target, updated: Object.keys(fields).length, draft: true };
}

/** 模組資料的翻譯草稿 → 上線（publish＋confirm）。頁面翻譯跟著 publish_site */
export async function publishTranslations(ctx: ServiceContext, input: { site?: string | null; lang?: string; target?: unknown; confirm?: boolean }) {
  requireScope(ctx, "publish");
  const tenant = await resolveTenant(ctx, input.site);
  await requireI18n(ctx, tenant);
  if (input.lang !== undefined && !isLangCode(input.lang)) throw new ServiceError("invalid", "不支援的語言代碼");
  let filter: { lang?: string; entityType?: TrEntityType; entityId?: string } = { lang: input.lang };
  if (input.target !== undefined) {
    const t = parse(targetSchema, input.target);
    if (t.type === "page" || t.type === "nav") throw new ServiceError("invalid", "頁面與導覽的翻譯跟著草稿走，請用 preview_changes → publish_site 發布");
    filter = { ...filter, entityType: t.type, entityId: (await findEntity(ctx.store, tenant.id, t)).id };
  }
  if (input.confirm !== true) throw new ServiceError("confirm_required", "發布翻譯會讓外文網址立即顯示這些譯文（含 AI 翻譯）。請先讓使用者確認，再以 confirm: true 呼叫。");
  const n = await ctx.store.publishTranslationDrafts(tenant.id, filter, ctx.actor.label);
  await audit(ctx, tenant.id, "i18n.publish", { ...filter, rows: n });
  return { published: n, note: "文章／商品／活動／課程的翻譯已上線；頁面與導覽的翻譯要 publish_site。" };
}

/** 翻譯進度：每個語言 × 頁面／模組資料（草稿 vs 已發布、AI 比例） */
export async function listTranslationStatus(ctx: ServiceContext, input: { site?: string | null; lang?: string }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireI18n(ctx, tenant);
  const draft = await loadDraft(ctx, tenant);
  const settings = i18nSettings.safeParse(draft.moduleSettings?.i18n ?? {});
  const langs = (settings.success ? settings.data.languages : []).filter((l) => !input.lang || l === input.lang);
  const out = [];
  for (const lang of langs) {
    const pages = draft.pages.map((p) => {
      const src = pageSourceFields(draft, p.path);
      const ex = existingPageTr(draft, lang, p.path);
      const done = Object.keys(src).filter((k) => ex[k]);
      return { path: p.path, fields: Object.keys(src).length, translated: done.length, ai: done.filter((k) => ex[k]!.ai).length };
    });
    const rows = await ctx.store.listTranslations(tenant.id, { lang });
    const entities: Record<string, { draft: number; published: number; aiDraft: number }> = {};
    for (const r of rows) {
      const k = `${r.entity_type}:${r.entity_id}`;
      const e = (entities[k] ??= { draft: 0, published: 0, aiDraft: 0 });
      if (r.draft_value !== null) e.draft++;
      if (r.published_value !== null) e.published++;
      if (r.draft_ai && r.draft_value !== null) e.aiDraft++;
    }
    out.push({ lang, pages, entities, unpublishedEntityDrafts: rows.filter((r) => r.draft_value !== null && (r.draft_value !== r.published_value || r.draft_ai !== r.published_ai)).length });
  }
  return { defaultLang: DEFAULT_LANG, languages: out, note: "頁面翻譯在草稿，publish_site 後上線；模組資料翻譯用 publish_translations。缺翻譯的欄位顯示中文。" };
}

/* ================================================================== 前台：模組資料套用翻譯 */

/**
 * 前台讀模組資料時套用目前語言的翻譯（缺的欄位維持中文）。已發布網站用 published_value；預覽模式用草稿（draft ?? published）。
 * 只覆蓋 ENTITY_FIELDS 裡的欄位：slug、價格、id 永遠是原值。
 */
export async function localizeRows<T extends { id: string }>(store: Store, site: Pick<LoadedSite, "tenant" | "lang" | "mode">, type: TrEntityType, rows: T[]): Promise<T[]> {
  if (!site.lang || site.lang === DEFAULT_LANG || !rows.length) return rows;
  const tr: TranslationRow[] = await store.listTranslations(site.tenant.id, { lang: site.lang, entityType: type, entityIds: rows.map((r) => r.id) });
  if (!tr.length) return rows;
  const allowed = new Set(ENTITY_FIELDS[type]);
  return rows.map((r) => {
    const mine = tr.filter((t) => t.entity_id === r.id && allowed.has(t.field));
    if (!mine.length) return r;
    const copy = { ...r } as Record<string, unknown>;
    for (const t of mine) {
      const v = site.mode === "preview" ? (t.draft_value ?? t.published_value) : t.published_value;
      if (v && typeof copy[t.field] === "string") copy[t.field] = v;
    }
    return copy as T;
  });
}
export async function localizeRow<T extends { id: string }>(store: Store, site: Pick<LoadedSite, "tenant" | "lang" | "mode">, type: TrEntityType, row: T | null): Promise<T | null> {
  if (!row) return row;
  return (await localizeRows(store, site, type, [row]))[0]!;
}

export async function localizeProducts<T extends { product: { id: string } }>(store: Store, site: Pick<LoadedSite, "tenant" | "lang" | "mode">, items: T[]): Promise<T[]> {
  const loc = await localizeRows(store, site, "product", items.map((i) => i.product));
  return items.map((i, k) => ({ ...i, product: loc[k]! }));
}

/** 活動／課程等「包著主資料」的列表 */
export async function localizeNested<T, K extends keyof T>(store: Store, site: Pick<LoadedSite, "tenant" | "lang" | "mode">, type: TrEntityType, items: T[], key: K): Promise<T[]> {
  const loc = await localizeRows(store, site, type, items.map((i) => i[key] as unknown as { id: string }));
  return items.map((i, k) => ({ ...i, [key]: loc[k]! }));
}
