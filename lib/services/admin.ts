import { requirePlatform, type ServiceContext } from "./context";

export async function listAuditLog(ctx: ServiceContext, input: { tenantId: string | null; limit?: number }) {
  requirePlatform(ctx);
  return ctx.store.listAudit(input.tenantId, Math.min(500, input.limit ?? 100));
}

export async function getTenantBySlugAdmin(ctx: ServiceContext, slug: string) {
  requirePlatform(ctx);
  return ctx.store.getTenantBySlug(slug);
}
