import { findSectionType, validateSectionProps } from "@/modules/registry";
import { siteContentSchema, type SiteContent } from "../content";
import { diffContent } from "../diff";
import { createPreviewToken, PREVIEW_TTL_SECONDS } from "../preview";
import type { TenantRow } from "../store/types";
import {
  ServiceError,
  activeModuleIds,
  audit,
  loadDraft,
  moduleStates,
  previewUrl,
  publicUrl,
  requireScope,
  resolveTenant,
  type ServiceContext,
} from "./context";

/** 發布前整份草稿的驗證：結構、區塊類型已啟用、props 合法 */
export function validateForPublish(content: SiteContent, active: Set<string>): string[] {
  const errors: string[] = [];
  const parsed = siteContentSchema.safeParse(content);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  for (const page of content.pages) {
    for (const s of page.sections) {
      const found = findSectionType(s.type);
      if (!found) {
        errors.push(`${page.path}#${s.id}: 未知區塊類型 ${s.type}`);
        continue;
      }
      if (!active.has(found.module.id)) errors.push(`${page.path}#${s.id}: 區塊 ${s.type} 的模組 ${found.module.id} 未啟用`);
      const r = validateSectionProps(s.type, s.props);
      if (!r.ok) errors.push(`${page.path}#${s.id}: ${r.errors.join("；")}`);
    }
  }
  return errors;
}

async function publishedContent(ctx: ServiceContext, tenant: TenantRow): Promise<{ number: number; content: SiteContent } | null> {
  if (!tenant.published_revision_id) return null;
  const rev = await ctx.store.getRevision(tenant.published_revision_id);
  return rev ? { number: rev.number, content: rev.content } : null;
}

export async function previewChanges(ctx: ServiceContext, input: { site?: string | null; path?: string }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const [draft, published, states] = await Promise.all([loadDraft(ctx, tenant), publishedContent(ctx, tenant), moduleStates(ctx, tenant.id)]);
  const changes = diffContent(published?.content ?? null, draft);
  const token = createPreviewToken(tenant.id, ctx.previewSecret);
  return {
    publishedRevision: published?.number ?? null,
    hasChanges: published ? changes.length > 0 : true,
    changes,
    validationErrors: validateForPublish(draft, activeModuleIds(states)),
    previewUrl: previewUrl(ctx, tenant.slug, token, input.path ?? "/"),
    previewExpiresInSeconds: PREVIEW_TTL_SECONDS,
    next: "請使用者打開 previewUrl 確認；確認後呼叫 publish_site 並帶 confirm: true。",
  };
}

export async function publishSite(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean; note?: string }) {
  requireScope(ctx, "publish");
  const tenant = await resolveTenant(ctx, input.site);
  if (input.confirm !== true) {
    throw new ServiceError(
      "confirm_required",
      "發布會讓變更立即對外上線。請先呼叫 preview_changes 取得差異摘要與預覽網址、讓使用者確認，再以 confirm: true 呼叫 publish_site。",
    );
  }
  if (tenant.status === "suspended") throw new ServiceError("forbidden", "網站已停用，無法發布");
  const [draft, published, states] = await Promise.all([loadDraft(ctx, tenant), publishedContent(ctx, tenant), moduleStates(ctx, tenant.id)]);
  const errors = validateForPublish(draft, activeModuleIds(states));
  if (errors.length) throw new ServiceError("invalid", `草稿有 ${errors.length} 個問題，無法發布：${errors.join("；")}`);
  const changes = diffContent(published?.content ?? null, draft);
  if (published && changes.length === 0) {
    throw new ServiceError("conflict", `草稿與目前已發布的第 ${published.number} 版相同，沒有可發布的變更`);
  }
  const rev = await ctx.store.publish(tenant.id, input.note?.slice(0, 300) ?? null, ctx.actor.label);
  await audit(ctx, tenant.id, "site.publish", { revision: rev.number, changes: changes.length, note: input.note ?? null });
  return { revision: rev.number, url: publicUrl(ctx, tenant.slug), changes };
}

export async function listRevisions(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const revs = await ctx.store.listRevisions(tenant.id);
  return revs.map((r) => ({
    number: r.number,
    note: r.note,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
    isCurrent: r.id === tenant.published_revision_id,
  }));
}

export async function rollback(ctx: ServiceContext, input: { site?: string | null; number: number; confirm?: boolean }) {
  requireScope(ctx, "publish");
  const tenant = await resolveTenant(ctx, input.site);
  if (input.confirm !== true) {
    throw new ServiceError(
      "confirm_required",
      `還原會讓第 ${input.number} 版立即上線，並用它覆蓋目前草稿（未發布的修改會消失）。確認後請以 confirm: true 再呼叫一次。`,
    );
  }
  const r = await ctx.store.rollback(tenant.id, input.number, ctx.actor.label);
  if (!r) {
    const revs = await ctx.store.listRevisions(tenant.id);
    throw new ServiceError("not_found", `沒有第 ${input.number} 版。現有版本：${revs.map((x) => x.number).join(", ") || "（尚未發布）"}`);
  }
  await audit(ctx, tenant.id, "site.rollback", { revision: r.number });
  return { publishedRevision: r.number, draftSyncedToRevision: r.number, url: publicUrl(ctx, tenant.slug) };
}
