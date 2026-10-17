import { z } from "zod";
import { imageUrl, optText, postSlug, safeHref, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import type { TenantRow } from "../store/types";

async function requireModule(ctx: ServiceContext, tenant: TenantRow, moduleId: string) {
  const active = activeModuleIds(await moduleStates(ctx, tenant.id));
  if (!active.has(moduleId)) throw new ServiceError("forbidden", `此網站未啟用模組「${moduleId}」，請先 enable_module ${moduleId}`);
}

/**
 * 文章／作品屬於模組資料、不在網站快照裡，狀態為 published 就直接對外。
 * 所以凡是「會改變線上內容」的寫入（新建為 published、修改已上線的項目、上架或下架），
 * 都要求 publish scope ＋ confirm: true —— 與 publish_site 同一道門檻。
 */
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) {
    throw new ServiceError("forbidden", `${what}會直接改變線上內容，需要 scope「publish」。沒有 publish 權限時請用 status: "draft"，再請有權限的人上架。`);
  }
  if (confirm !== true) {
    throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
  }
}

/* ------------------------------------------------------------------ 文章 */

export const postInput = z
  .object({
    slug: postSlug,
    title: text(160),
    excerpt: optText(400),
    bodyMd: z.string().max(100_000).default(""),
    coverUrl: imageUrl.optional(),
    status: z.enum(["draft", "published"]).default("draft"),
    publishedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const postPatch = postInput.partial().strict();

function postSummary(p: { id: string; slug: string; title: string; status: string; published_at: string | null; excerpt: string | null }) {
  return { id: p.id, slug: p.slug, title: p.title, status: p.status, publishedAt: p.published_at, excerpt: p.excerpt };
}

export async function createPost(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof postInput>) {
  requireScope(ctx, "content:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireModule(ctx, tenant, "blog");
  const d = parse(postInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接發布文章", confirm);
  if (await ctx.store.getPostBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `文章 slug「${d.slug}」已存在，請用 update_post 或換 slug`);
  const row = await ctx.store.insertPost({
    tenant_id: tenant.id,
    slug: d.slug,
    title: d.title,
    excerpt: d.excerpt ?? null,
    body_md: d.bodyMd,
    cover_url: d.coverUrl ?? null,
    status: d.status,
    published_at: d.status === "published" ? (d.publishedAt ?? new Date().toISOString()) : (d.publishedAt ?? null),
  });
  await audit(ctx, tenant.id, "post.create", { postId: row.id, slug: row.slug, status: row.status });
  return {
    ...postSummary(row),
    note: row.status === "published" ? "文章已直接上線（文章不經網站草稿/發布流程）。" : "文章為草稿，status 改為 published 才會上線。",
  };
}

export async function updatePost(
  ctx: ServiceContext,
  input: { site?: string | null; postId?: string; slug?: string; confirm?: boolean } & { patch: z.input<typeof postPatch> },
) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireModule(ctx, tenant, "blog");
  const existing = input.postId
    ? await ctx.store.getPostById(tenant.id, input.postId)
    : input.slug
      ? await ctx.store.getPostBySlug(tenant.id, input.slug)
      : null;
  if (!existing) throw new ServiceError("not_found", "找不到文章（請給 postId 或 slug）");
  const p = parse(postPatch, input.patch);
  const nextStatus = input.patch.status ?? existing.status;
  if (existing.status === "published" || nextStatus === "published") requireLiveConfirm(ctx, "修改／上架／下架已公開的文章", input.confirm);
  if (p.slug && p.slug !== existing.slug && (await ctx.store.getPostBySlug(tenant.id, p.slug))) {
    throw new ServiceError("conflict", `文章 slug「${p.slug}」已存在`);
  }
  const patch: Record<string, unknown> = {};
  if (p.slug !== undefined) patch.slug = p.slug;
  if (p.title !== undefined) patch.title = p.title;
  if (p.excerpt !== undefined) patch.excerpt = p.excerpt;
  if (p.bodyMd !== undefined && input.patch.bodyMd !== undefined) patch.body_md = p.bodyMd;
  if (p.coverUrl !== undefined) patch.cover_url = p.coverUrl;
  if (input.patch.status !== undefined) patch.status = p.status;
  if (p.publishedAt !== undefined) patch.published_at = p.publishedAt;
  if (patch.status === "published" && !existing.published_at && !patch.published_at) patch.published_at = new Date().toISOString();
  const row = await ctx.store.updatePost(tenant.id, existing.id, patch);
  await audit(ctx, tenant.id, "post.update", { postId: row.id, keys: Object.keys(patch) });
  return postSummary(row);
}

export async function listPosts(ctx: ServiceContext, input: { site?: string | null; status?: "draft" | "published"; limit?: number; offset?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const r = await ctx.store.listPosts(tenant.id, { status: input.status, limit, offset: Math.max(0, input.offset ?? 0) });
  return { total: r.total, posts: r.rows.map(postSummary) };
}

/* ------------------------------------------------------------------ 作品集 */

export const portfolioInput = z
  .object({
    title: text(160),
    description: optText(2000),
    imageUrl,
    linkUrl: safeHref.optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    sort: z.number().int().min(-10000).max(10000).default(0),
    status: z.enum(["draft", "published"]).default("draft"),
  })
  .strict();

export async function createPortfolioItem(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof portfolioInput>) {
  requireScope(ctx, "content:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireModule(ctx, tenant, "portfolio");
  const d = parse(portfolioInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接公開作品", confirm);
  const row = await ctx.store.insertPortfolioItem({
    tenant_id: tenant.id,
    title: d.title,
    description: d.description ?? null,
    image_url: d.imageUrl,
    link_url: d.linkUrl ?? null,
    tags: d.tags,
    sort: d.sort,
    status: d.status,
  });
  await audit(ctx, tenant.id, "portfolio.create", { itemId: row.id });
  return { id: row.id, title: row.title, status: row.status, tags: row.tags };
}

export async function updatePortfolioItem(
  ctx: ServiceContext,
  input: { site?: string | null; itemId: string; patch: Partial<z.input<typeof portfolioInput>>; confirm?: boolean },
) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireModule(ctx, tenant, "portfolio");
  const existing = await ctx.store.getPortfolioItem(tenant.id, input.itemId);
  if (!existing) throw new ServiceError("not_found", `找不到作品 ${input.itemId}`);
  const p = parse(portfolioInput.partial().strict(), input.patch);
  const nextStatus = input.patch.status ?? existing.status;
  if (existing.status === "published" || nextStatus === "published") requireLiveConfirm(ctx, "修改／上架／下架已公開的作品", input.confirm);
  const patch: Record<string, unknown> = {};
  const given = input.patch;
  if (given.title !== undefined) patch.title = p.title;
  if (given.description !== undefined) patch.description = p.description;
  if (given.imageUrl !== undefined) patch.image_url = p.imageUrl;
  if (given.linkUrl !== undefined) patch.link_url = p.linkUrl;
  if (given.tags !== undefined) patch.tags = p.tags;
  if (given.sort !== undefined) patch.sort = p.sort;
  if (given.status !== undefined) patch.status = p.status;
  const row = await ctx.store.updatePortfolioItem(tenant.id, existing.id, patch);
  await audit(ctx, tenant.id, "portfolio.update", { itemId: row.id, keys: Object.keys(patch) });
  return { id: row.id, title: row.title, status: row.status, tags: row.tags };
}

export async function listPortfolioItems(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const rows = await ctx.store.listPortfolio(tenant.id, {});
  return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, tags: r.tags, sort: r.sort }));
}
