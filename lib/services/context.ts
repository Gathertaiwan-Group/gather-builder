import type { Mailer } from "../mail";
import { siteUrl, type SiteRef } from "../site-url";
import type { Store, TenantRow, TenantModuleRow } from "../store/types";
import type { Actor } from "../tokens";
import type { Scope } from "../scopes";
import { siteContentSchema, type SiteContent } from "../content";

/**
 * 服務層：後台與 MCP 共用的唯一一套寫入/讀取邏輯（一層 API、兩個入口）。
 * 權限（scope）與租戶隔離在這一層強制，入口只負責認證與參數轉送。
 */
export interface ServiceContext {
  actor: Actor;
  store: Store;
  /** 產生預覽網址用，例如 https://builder.example.com */
  baseUrl: string;
  previewSecret: string;
  /** 寄信（Resend）；沒設 RESEND_API_KEY 時為 undefined，呼叫端略過不報錯 */
  sendMail?: Mailer;
}

export { ServiceError, type ServiceErrorCode } from "../errors";
import { ServiceError } from "../errors";

export function requireScope(ctx: ServiceContext, scope: Scope): void {
  if (!ctx.actor.scopes.includes(scope)) {
    throw new ServiceError("forbidden", `權限不足：這個動作需要 scope「${scope}」，目前 token 只有：${ctx.actor.scopes.join(", ") || "（無）"}`);
  }
}

/**
 * 金流／發票／物流憑證、自有網域、店主成員這類「只能從後台表單操作、不經過 agent 對話」的動作：
 * 平台擁有者後台（admin），或店主後台的 owner 角色（租戶隔離仍由 resolveTenant 負責）。editor／viewer、MCP token 一律拒絕。
 */
export function requireFormCredential(ctx: ServiceContext, what: string): void {
  if (ctx.actor.kind === "admin") return;
  if (ctx.actor.kind === "owner" && ctx.actor.role === "owner" && ctx.actor.tenantId) return;
  throw new ServiceError("forbidden", `${what}只能由平台後台或店主（owner）在後台表單操作（不經過 agent 對話）`);
}

export function requirePlatform(ctx: ServiceContext): void {
  requireScope(ctx, "platform:sites");
  if (ctx.actor.tenantId !== null) throw new ServiceError("forbidden", "這個動作只限平台級 token（租戶 token 不能使用）");
}

/**
 * 決定要操作的租戶並強制隔離：
 * - 租戶 token：只能操作自己；帶了別的 site 直接拒絕。
 * - 平台 token／後台：必須指定 site（slug）。
 */
export async function resolveTenant(ctx: ServiceContext, site?: string | null): Promise<TenantRow> {
  const { actor, store } = ctx;
  if (actor.tenantId) {
    const own = await store.getTenantById(actor.tenantId);
    if (!own) throw new ServiceError("not_found", "token 對應的網站已不存在");
    if (site && site !== own.slug) {
      throw new ServiceError("forbidden", `這個 token 只能操作網站「${own.slug}」，不能操作「${site}」`);
    }
    return own;
  }
  if (!site) throw new ServiceError("invalid", "平台 token 必須用 site 參數指定網站 slug");
  const t = await store.getTenantBySlug(site);
  if (!t) throw new ServiceError("not_found", `找不到網站「${site}」`);
  return t;
}

export async function audit(ctx: ServiceContext, tenantId: string | null, action: string, payload: Record<string, unknown> = {}) {
  await ctx.store.insertAudit({ tenant_id: tenantId, actor: ctx.actor.label, action, payload });
}

export async function loadDraft(ctx: ServiceContext, tenant: TenantRow): Promise<SiteContent> {
  return (await loadDraftRow(ctx, tenant)).content;
}

export async function loadDraftRow(ctx: ServiceContext, tenant: TenantRow): Promise<{ content: SiteContent; version: number }> {
  const d = await ctx.store.getDraft(tenant.id);
  if (!d) throw new ServiceError("not_found", `網站「${tenant.slug}」沒有草稿`);
  return { content: d.content, version: d.version };
}

/**
 * 讀草稿 → 修改 → 驗證整份結構 → 以樂觀鎖存回（version 不符代表期間有人寫過）。
 * 衝突時重新讀取最新草稿、重套一次修改；再衝突就回 conflict，不會默默蓋掉別人的修改。
 * 只動草稿，不影響已發布版本。
 */
export async function mutateDraft<T>(
  ctx: ServiceContext,
  tenant: TenantRow,
  fn: (draft: SiteContent) => T,
): Promise<{ result: T; content: SiteContent; version: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await loadDraftRow(ctx, tenant);
    const draft = structuredClone(row.content);
    const result = fn(draft);
    const parsed = siteContentSchema.safeParse(draft);
    if (!parsed.success) {
      throw new ServiceError(
        "invalid",
        `修改後的網站結構不合法：${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("；")}`,
      );
    }
    const version = await ctx.store.saveDraft(tenant.id, parsed.data, ctx.actor.label, row.version);
    if (version !== null) return { result, content: parsed.data, version };
  }
  throw new ServiceError("conflict", "草稿同時被其他人修改，請重新讀取（get_site / get_page）後再試一次。");
}

export async function moduleStates(ctx: Pick<ServiceContext, "store">, tenantId: string): Promise<Map<string, TenantModuleRow>> {
  const rows = await ctx.store.listTenantModules(tenantId);
  return new Map(rows.map((r) => [r.module_id, r]));
}

/** enabled 或 pending_setup 都算「已開通」（pending 只是設定未完成） */
export function activeModuleIds(states: Map<string, TenantModuleRow>): Set<string> {
  return new Set([...states.values()].filter((r) => r.status !== "disabled").map((r) => r.module_id));
}

/** 預覽網址：開在租戶的正式網址上（子網域／自有網域；沒有就 /s/<slug>），lib/site-url.ts */
export function previewUrl(ctx: ServiceContext, tenant: SiteRef, token: string, path = "/"): string {
  return `${siteUrl(tenant, path, ctx.baseUrl)}?preview=${encodeURIComponent(token)}`;
}

export function publicUrl(ctx: ServiceContext, tenant: SiteRef, path = "/"): string {
  return siteUrl(tenant, path, ctx.baseUrl);
}
