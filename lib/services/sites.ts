import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defaultContent, findPage, normalizePath, type NavItem, type SiteContent } from "../content";
import { MODULES, findSectionType, getModule, resolveDependencies, validateSectionProps, DependencyError } from "@/modules/registry";
import { THEME_PRESETS, themeOverridesSchema } from "../themes";
import { generateToken } from "../tokens";
import { TENANT_SCOPES } from "../scopes";
import { createPreviewToken } from "../preview";
import { pagePath, siteSlug, text } from "../validators";
import {
  ServiceError,
  activeModuleIds,
  audit,
  loadDraft,
  moduleStates,
  mutateDraft,
  previewUrl,
  publicUrl,
  requirePlatform,
  requireScope,
  resolveTenant,
  type ServiceContext,
} from "./context";
import type { TenantRow } from "../store/types";

export function newSectionId(): string {
  return `s_${randomBytes(6).toString("hex").slice(0, 10)}`;
}

/* ------------------------------------------------------------------ 平台 */

export function listModules() {
  return MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    category: m.category,
    priceSetup: m.priceSetup,
    priceMonthly: m.priceMonthly,
    requires: m.requires,
    sectionTypes: m.sectionTypes.map((s) => s.type),
    locked: !!m.locked,
  }));
}

export const createSiteInput = z.object({
  slug: siteSlug,
  name: text(120),
  modules: z.array(z.string()).max(20).optional(),
  themePreset: z.enum(THEME_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(),
  test: z.boolean().optional(),
});

export async function createSite(ctx: ServiceContext, input: z.input<typeof createSiteInput>) {
  requirePlatform(ctx);
  const data = parse(createSiteInput, input);
  let moduleIds: string[];
  try {
    moduleIds = resolveDependencies(["core", ...(data.modules ?? ["sections-basic"])]);
  } catch (e) {
    if (e instanceof DependencyError) throw new ServiceError("invalid", e.message);
    throw e;
  }
  if (await ctx.store.getTenantBySlug(data.slug)) throw new ServiceError("conflict", `slug「${data.slug}」已被使用，請換一個`);

  const tenant = await ctx.store.insertTenant({
    slug: data.slug,
    name: data.name,
    status: "trial",
    theme: {},
    settings: {},
    is_test: !!data.test,
  });

  const now = new Date().toISOString();
  const statuses: { id: string; status: string }[] = [];
  for (const id of moduleIds) {
    const m = getModule(id)!;
    const status = m.settingsSchema.safeParse({}).success ? "enabled" : "pending_setup";
    await ctx.store.upsertTenantModule({ tenant_id: tenant.id, module_id: id, status, config: {}, enabled_at: now });
    statuses.push({ id, status });
  }

  const content = defaultContent(data.name, data.themePreset);
  if (moduleIds.includes("sections-basic")) {
    content.pages[0]!.sections.push({
      id: newSectionId(),
      type: "hero",
      props: { heading: data.name, subheading: "網站建置中，敬請期待。", align: "center" },
    });
  }
  await ctx.store.saveDraft(tenant.id, content, ctx.actor.label);

  const tok = generateToken("tenant");
  const tokenRow = await ctx.store.insertToken({
    tenant_id: tenant.id,
    name: "default (create_site)",
    token_hash: tok.hash,
    token_prefix: tok.prefix,
    scopes: TENANT_SCOPES,
  });

  await audit(ctx, tenant.id, "site.create", { slug: data.slug, modules: moduleIds, tokenId: tokenRow.id, test: !!data.test });
  return {
    siteId: tenant.id,
    slug: tenant.slug,
    modules: statuses,
    previewUrl: previewUrl(ctx, tenant.slug, createPreviewToken(tenant.id, ctx.previewSecret)),
    publicUrl: publicUrl(ctx, tenant.slug),
    token: tok.raw,
    tokenScopes: TENANT_SCOPES,
    note: "token 原文只顯示這一次，請妥善保存。網站尚未發布，修改完成後呼叫 preview_changes 再 publish_site。",
  };
}

/* ------------------------------------------------------------------ 讀取 */

export async function getSite(ctx: ServiceContext, site?: string | null) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, site);
  const [draft, states, revisions] = await Promise.all([
    loadDraft(ctx, tenant),
    moduleStates(ctx, tenant.id),
    ctx.store.listRevisions(tenant.id),
  ]);
  const current = revisions.find((r) => r.id === tenant.published_revision_id);
  let dirty = true;
  if (current) {
    const rev = await ctx.store.getRevision(current.id);
    dirty = JSON.stringify(rev?.content) !== JSON.stringify(draft);
  }
  return {
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    modules: [...states.values()].map((m) => ({ id: m.module_id, status: m.status, config: m.config })),
    theme: draft.theme,
    nav: draft.nav,
    pages: draft.pages.map((p) => ({
      path: p.path,
      title: p.title,
      sections: p.sections.map((s) => ({ id: s.id, type: s.type })),
    })),
    publishedRevision: current?.number ?? null,
    revisionCount: revisions.length,
    draftHasUnpublishedChanges: dirty,
    publicUrl: publicUrl(ctx, tenant.slug),
  };
}

export async function getPage(ctx: ServiceContext, input: { site?: string | null; path: string }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const draft = await loadDraft(ctx, tenant);
  const page = findPage(draft, input.path);
  if (!page) throw new ServiceError("not_found", `草稿中沒有頁面 ${input.path}。現有頁面：${draft.pages.map((p) => p.path).join(", ")}`);
  return page;
}

export async function listSectionTypes(ctx: ServiceContext, site?: string | null) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, site);
  const active = activeModuleIds(await moduleStates(ctx, tenant.id));
  return MODULES.filter((m) => active.has(m.id)).flatMap((m) =>
    m.sectionTypes.map((s) => ({
      type: s.type,
      module: m.id,
      label: s.label,
      description: s.description,
      propsJsonSchema: z.toJSONSchema(s.schema, { io: "input", unrepresentable: "any" }),
      example: s.example,
    })),
  );
}

/* ------------------------------------------------------------------ 區塊 */

async function assertSectionAllowed(ctx: ServiceContext, tenant: TenantRow, type: string) {
  const found = findSectionType(type);
  if (!found) throw new ServiceError("invalid", `未知區塊類型「${type}」。用 list_section_types 查可用類型。`);
  const active = activeModuleIds(await moduleStates(ctx, tenant.id));
  if (!active.has(found.module.id)) {
    throw new ServiceError("forbidden", `區塊「${type}」屬於模組「${found.module.id}」，此網站尚未啟用。請先 enable_module ${found.module.id}。`);
  }
}

function checkProps(type: string, props: unknown): Record<string, unknown> {
  const r = validateSectionProps(type, props);
  if (!r.ok) throw new ServiceError("invalid", `區塊「${type}」的 props 不合法：${r.errors.join("；")}`);
  return r.props;
}

function pageOrThrow(draft: SiteContent, path: string) {
  const page = findPage(draft, path);
  if (!page) throw new ServiceError("not_found", `草稿中沒有頁面 ${path}。現有頁面：${draft.pages.map((p) => p.path).join(", ")}（可用 upsert_page 新增）`);
  return page;
}

export async function addSection(
  ctx: ServiceContext,
  input: { site?: string | null; path: string; type: string; props?: Record<string, unknown>; position?: number },
) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await assertSectionAllowed(ctx, tenant, input.type);
  const props = checkProps(input.type, input.props ?? {});
  const id = newSectionId();
  const { result } = await mutateDraft(ctx, tenant, (draft) => {
    const page = pageOrThrow(draft, input.path);
    const pos = input.position === undefined ? page.sections.length : Math.max(0, Math.min(page.sections.length, input.position));
    page.sections.splice(pos, 0, { id, type: input.type, props });
    return { position: pos, total: page.sections.length };
  });
  await audit(ctx, tenant.id, "section.add", { path: input.path, type: input.type, sectionId: id });
  return { sectionId: id, path: normalizePath(input.path), ...result, draft: true };
}

export async function updateSection(
  ctx: ServiceContext,
  input: { site?: string | null; path: string; sectionId: string; props: Record<string, unknown>; replace?: boolean },
) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  const draft0 = await loadDraft(ctx, tenant);
  const sec0 = pageOrThrow(draft0, input.path).sections.find((s) => s.id === input.sectionId);
  if (!sec0) throw new ServiceError("not_found", `頁面 ${input.path} 沒有區塊 ${input.sectionId}`);
  await assertSectionAllowed(ctx, tenant, sec0.type);
  const merged = input.replace ? input.props : { ...sec0.props, ...input.props };
  const props = checkProps(sec0.type, merged);
  await mutateDraft(ctx, tenant, (draft) => {
    const sec = pageOrThrow(draft, input.path).sections.find((s) => s.id === input.sectionId);
    if (!sec) throw new ServiceError("not_found", `頁面 ${input.path} 沒有區塊 ${input.sectionId}`);
    sec.props = props;
  });
  await audit(ctx, tenant.id, "section.update", { path: input.path, sectionId: input.sectionId, keys: Object.keys(input.props) });
  return { sectionId: input.sectionId, type: sec0.type, updatedKeys: Object.keys(input.props), draft: true };
}

export async function removeSection(ctx: ServiceContext, input: { site?: string | null; path: string; sectionId: string }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  const { result } = await mutateDraft(ctx, tenant, (draft) => {
    const page = pageOrThrow(draft, input.path);
    const idx = page.sections.findIndex((s) => s.id === input.sectionId);
    if (idx < 0) throw new ServiceError("not_found", `頁面 ${input.path} 沒有區塊 ${input.sectionId}`);
    const [removed] = page.sections.splice(idx, 1);
    return { type: removed!.type, remaining: page.sections.length };
  });
  await audit(ctx, tenant.id, "section.remove", { path: input.path, sectionId: input.sectionId });
  return { removed: input.sectionId, ...result, draft: true };
}

export async function moveSection(ctx: ServiceContext, input: { site?: string | null; path: string; sectionId: string; toIndex: number }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  const { result } = await mutateDraft(ctx, tenant, (draft) => {
    const page = pageOrThrow(draft, input.path);
    const idx = page.sections.findIndex((s) => s.id === input.sectionId);
    if (idx < 0) throw new ServiceError("not_found", `頁面 ${input.path} 沒有區塊 ${input.sectionId}`);
    const [sec] = page.sections.splice(idx, 1);
    const to = Math.max(0, Math.min(page.sections.length, input.toIndex));
    page.sections.splice(to, 0, sec!);
    return { from: idx, to, order: page.sections.map((s) => `${s.type}:${s.id}`) };
  });
  await audit(ctx, tenant.id, "section.move", { path: input.path, sectionId: input.sectionId, to: result.to });
  return { ...result, draft: true };
}

/* ------------------------------------------------------------------ 頁面與導覽 */

const seoInput = z
  .object({ title: z.string().max(120).optional(), description: z.string().max(300).optional(), ogImage: z.string().optional() })
  .strict();

export async function upsertPage(
  ctx: ServiceContext,
  input: { site?: string | null; path: string; title: string; seo?: z.input<typeof seoInput>; addToNav?: boolean },
) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  const path = parse(pagePath, normalizePath(input.path));
  const seo = input.seo ? parse(seoInput, input.seo) : undefined;
  const { result } = await mutateDraft(ctx, tenant, (draft) => {
    const existing = findPage(draft, path);
    if (existing) {
      existing.title = input.title;
      if (seo) existing.seo = { ...existing.seo, ...seo };
    } else {
      draft.pages.push({ path, title: input.title, seo: seo ?? {}, sections: [] });
    }
    if (input.addToNav && !draft.nav.some((n) => n.href === path)) draft.nav.push({ label: input.title.slice(0, 40), href: path });
    return { created: !existing };
  });
  await audit(ctx, tenant.id, result.created ? "page.create" : "page.update", { path });
  return { path, ...result, draft: true };
}

export async function deletePage(ctx: ServiceContext, input: { site?: string | null; path: string }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  const path = normalizePath(input.path);
  if (path === "/") throw new ServiceError("invalid", "首頁 / 不能刪除");
  const { result } = await mutateDraft(ctx, tenant, (draft) => {
    const idx = draft.pages.findIndex((p) => p.path === path);
    if (idx < 0) throw new ServiceError("not_found", `草稿中沒有頁面 ${path}`);
    draft.pages.splice(idx, 1);
    const before = draft.nav.length;
    draft.nav = draft.nav.filter((n) => n.href !== path);
    return { removedNavItems: before - draft.nav.length };
  });
  await audit(ctx, tenant.id, "page.delete", { path });
  return { deleted: path, ...result, draft: true };
}

export async function updateNav(ctx: ServiceContext, input: { site?: string | null; items: NavItem[] }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await mutateDraft(ctx, tenant, (draft) => {
    draft.nav = input.items;
  });
  await audit(ctx, tenant.id, "nav.update", { count: input.items.length });
  return { nav: input.items.map((n) => `${n.label} → ${n.href}`), draft: true };
}

/* ------------------------------------------------------------------ 設計 */

export async function updateTheme(
  ctx: ServiceContext,
  input: { site?: string | null; preset?: string; overrides?: Record<string, string>; resetOverrides?: boolean },
) {
  requireScope(ctx, "design:write");
  const tenant = await resolveTenant(ctx, input.site);
  if (input.preset && !THEME_PRESETS.some((p) => p.id === input.preset)) {
    throw new ServiceError("invalid", `未知主題「${input.preset}」。可用：${THEME_PRESETS.map((p) => `${p.id}（${p.name}）`).join("、")}`);
  }
  const overrides = input.overrides ? parse(themeOverridesSchema, input.overrides) : {};
  const { content } = await mutateDraft(ctx, tenant, (draft) => {
    if (input.preset) draft.theme.preset = input.preset;
    draft.theme.overrides = { ...(input.resetOverrides ? {} : draft.theme.overrides), ...overrides };
  });
  await audit(ctx, tenant.id, "theme.update", { preset: input.preset, overrides: Object.keys(overrides), reset: !!input.resetOverrides });
  return { theme: content.theme, draft: true };
}

/* ------------------------------------------------------------------ 後台用 */

export async function listTenants(ctx: ServiceContext) {
  requirePlatform(ctx);
  return ctx.store.listTenants();
}

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ServiceError("invalid", r.error.issues.map((i) => `${i.path.join(".") || "(值)"}: ${i.message}`).join("；"));
  }
  return r.data;
}
