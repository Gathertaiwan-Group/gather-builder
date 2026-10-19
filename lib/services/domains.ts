import { z } from "zod";
import { getDomainAdapter, type DomainAdapter } from "../domains/adapter";
import { classifyHost, hostConfigFromEnv, normalizeHost } from "../host-routing";
import { siteBase } from "../site-url";
import type { Store, TenantDomainRow } from "../store/types";
import { ServiceError, audit, requireFormCredential, requireScope, resolveTenant, type ServiceContext } from "./context";

/**
 * 自有網域（第九批）：店主在後台輸入網域 → 加到 Vercel 專案、回傳要設定的 DNS 記錄（pending）
 * → 檢查（後台「重新檢查」＋每日 cron 輪詢）→ verified → 店主按「啟用」→ active（成為正式網址，子網域 301 過去）。
 * 🔴 只有平台後台或店主 owner 角色能新增／啟用／移除（requireFormCredential）；MCP 只能讀狀態。
 * 🔴 只有 active 的網域會被 middleware 對應到租戶；pending／verified 都不生效。
 */
export const domainInput = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
  .pipe(z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, { message: "網域格式不正確（例如 shop.example.com）" }).max(253));

function adapterOr(adapter?: DomainAdapter | null): DomainAdapter {
  const a = adapter === undefined ? getDomainAdapter() : adapter;
  if (!a) throw new ServiceError("invalid", "平台尚未設定網域 API（VERCEL_DOMAINS_TOKEN／VERCEL_DOMAINS_PROJECT_ID），暫時無法新增自有網域");
  return a;
}

function summary(d: TenantDomainRow) {
  return {
    id: d.id,
    domain: d.domain,
    status: d.status,
    dnsRecords: d.dns_records,
    lastCheckedAt: d.last_checked_at,
    lastError: d.last_error,
    verifiedAt: d.verified_at,
    activatedAt: d.activated_at,
  };
}

export async function listDomains(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  const rows = await ctx.store.listTenantDomains(tenant.id);
  return {
    primaryDomain: tenant.primary_domain,
    siteUrl: siteBase(tenant, ctx.baseUrl),
    subdomainEnabled: !!hostConfigFromEnv().sitesDomain,
    domains: rows.map(summary),
  };
}

export async function addDomain(ctx: ServiceContext, input: { site?: string | null; domain: string }, adapter?: DomainAdapter | null) {
  requireFormCredential(ctx, "自有網域");
  const tenant = await resolveTenant(ctx, input.site);
  const p = domainInput.safeParse(input.domain);
  if (!p.success) throw new ServiceError("invalid", p.error.issues.map((i) => i.message).join("；"));
  const domain = normalizeHost(p.data)!;
  const cfg = hostConfigFromEnv();
  const kind = classifyHost(domain, cfg);
  if (kind.kind !== "custom") throw new ServiceError("invalid", "這個網域是平台自己的網址（或平台子網域），不能當自有網域");
  if ((await ctx.store.listTenantDomains(tenant.id)).length >= 5) throw new ServiceError("invalid", "每個網站最多 5 個網域");
  const existing = await ctx.store.getDomainByName(domain);
  if (existing) throw new ServiceError("conflict", existing.tenant_id === tenant.id ? "這個網域已經加過了" : "這個網域已被其他網站使用");
  const a = adapterOr(adapter);
  const r = await a.add(domain);
  if (r.error && !r.records.length) throw new ServiceError("invalid", `無法加入網域：${r.error}`);
  const row = await ctx.store.insertTenantDomain({ tenant_id: tenant.id, domain, dns_records: r.records, created_by: ctx.actor.label });
  if (r.error) await ctx.store.updateTenantDomain(tenant.id, row.id, { last_error: r.error.slice(0, 300) });
  await audit(ctx, tenant.id, "domain.add", { domain, adapter: a.name });
  return { ...summary(row), note: "請到網域的 DNS 管理介面設定下列記錄，生效後按「重新檢查」（系統每天也會自動檢查）。驗證完成後按「啟用」才會成為正式網址。" };
}

/** 檢查一筆 pending／verified 網域（後台按鈕、cron 共用；不需 confirm） */
export async function checkDomainRow(store: Store, d: TenantDomainRow, adapter: DomainAdapter): Promise<TenantDomainRow> {
  const r = await adapter.check(d.domain);
  const nowIso = new Date().toISOString();
  const ok = r.verified && r.configured;
  const next = await store.updateTenantDomain(
    d.tenant_id,
    d.id,
    {
      last_checked_at: nowIso,
      last_error: ok ? null : (r.error ?? (r.verified ? "DNS 還沒指到平台（A／CNAME 記錄未生效）" : "網域所有權尚未驗證（TXT 記錄未生效）")).slice(0, 300),
      dns_records: r.records.length ? r.records : d.dns_records,
      ...(ok && d.status === "pending" ? { status: "verified" as const, verified_at: nowIso } : {}),
    },
    d.status === "pending" ? ["pending"] : undefined,
  );
  if (ok && d.status === "pending" && next?.status === "verified") await store.insertAudit({ tenant_id: d.tenant_id, actor: `domain:${adapter.name}`, action: "domain.verified", payload: { domain: d.domain } });
  return next ?? d;
}

export async function checkDomain(ctx: ServiceContext, input: { site?: string | null; domainId: string }, adapter?: DomainAdapter | null) {
  requireFormCredential(ctx, "自有網域");
  const tenant = await resolveTenant(ctx, input.site);
  const d = await ctx.store.getTenantDomain(tenant.id, input.domainId);
  if (!d) throw new ServiceError("not_found", "找不到這個網域");
  return summary(await checkDomainRow(ctx.store, d, adapterOr(adapter)));
}

export async function activateDomain(ctx: ServiceContext, input: { site?: string | null; domainId: string; confirm?: boolean }) {
  requireFormCredential(ctx, "自有網域");
  const tenant = await resolveTenant(ctx, input.site);
  const d = await ctx.store.getTenantDomain(tenant.id, input.domainId);
  if (!d) throw new ServiceError("not_found", "找不到這個網域");
  if (d.status === "pending") throw new ServiceError("invalid", "網域還在驗證中，DNS 生效、驗證完成後才能啟用");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `啟用後 ${d.domain} 會成為網站的正式網址（子網域與 /s/ 網址會轉到這裡，搜尋引擎 canonical 也會改）。請確認後以 confirm: true 呼叫。`);
  const domain = await ctx.store.activateTenantDomain(tenant.id, d.id);
  await audit(ctx, tenant.id, "domain.activate", { domain });
  return { domain, status: "active" as const, siteUrl: `https://${domain}`, note: "最多約 30 秒後各伺服器生效。" };
}

export async function removeDomain(ctx: ServiceContext, input: { site?: string | null; domainId: string; confirm?: boolean }, adapter?: DomainAdapter | null) {
  requireFormCredential(ctx, "自有網域");
  const tenant = await resolveTenant(ctx, input.site);
  const d = await ctx.store.getTenantDomain(tenant.id, input.domainId);
  if (!d) throw new ServiceError("not_found", "找不到這個網域");
  if (input.confirm !== true) throw new ServiceError("confirm_required", `移除 ${d.domain}${d.status === "active" ? "（目前的正式網址，移除後改回子網域）" : ""}？請確認後以 confirm: true 呼叫。`);
  await adapterOr(adapter).remove(d.domain);
  await ctx.store.deleteTenantDomain(tenant.id, d.id);
  await audit(ctx, tenant.id, "domain.remove", { domain: d.domain, wasActive: d.status === "active" });
  return { removed: d.domain };
}

/** 每日 cron：輪詢 pending 網域的驗證狀態（沒設定 adapter 就略過） */
export async function sweepPendingDomains(store: Store, adapter: DomainAdapter | null = getDomainAdapter(), limit = 50) {
  if (!adapter) return { checked: 0, verified: 0 };
  let verified = 0;
  const rows = await store.listPendingDomains(limit);
  for (const d of rows) {
    const after = await checkDomainRow(store, d, adapter).catch((e) => (console.error("[domains] check", e), d));
    if (after.status === "verified") verified++;
  }
  return { checked: rows.length, verified };
}
