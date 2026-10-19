import { checkDisable, getModule, resolveDependencies, DependencyError } from "@/modules/registry";
import { adjustModuleStatus } from "../shop/status";
import { ServiceError, activeModuleIds, audit, loadDraft, moduleStates, mutateDraft, requireScope, resolveTenant, type ServiceContext } from "./context";

function issues(err: { issues: { path: PropertyKey[]; message: string }[] }) {
  return err.issues.map((i) => `${i.path.map(String).join(".") || "(config)"}: ${i.message}`).join("；");
}

export async function enableModule(ctx: ServiceContext, input: { site?: string | null; moduleId: string; config?: Record<string, unknown> }) {
  requireScope(ctx, "modules:write");
  const tenant = await resolveTenant(ctx, input.site);
  let ids: string[];
  try {
    ids = resolveDependencies([input.moduleId]);
  } catch (e) {
    if (e instanceof DependencyError) throw new ServiceError("invalid", e.message);
    throw e;
  }
  const target = getModule(input.moduleId)!;
  // 第九批：經 /build 開的站（有平台月費）→ 付費模組要先購買（後台「方案與加購」／create_build_checkout），平台後台不受限
  if (ctx.actor.kind !== "admin") {
    const billing = await ctx.store.getTenantBilling(tenant.id);
    if (billing) {
      const enabledNow = new Set((await ctx.store.listTenantModules(tenant.id)).filter((m) => m.status !== "disabled").map((m) => m.module_id));
      const unpaid = ids.filter((id) => !billing.modules.includes(id) && !enabledNow.has(id) && ((getModule(id)?.priceSetup ?? 0) > 0 || (getModule(id)?.priceMonthly ?? 0) > 0));
      if (unpaid.length) throw new ServiceError("forbidden", `模組 ${unpaid.join(", ")} 需要先購買：請到店主後台「方案與加購」付款（或 MCP create_build_checkout 帶 site 產生付款連結），付款後會自動開通。`);
    }
  }
  if (input.config) {
    const r = target.settingsSchema.safeParse(input.config);
    if (!r.success) throw new ServiceError("invalid", `模組 ${input.moduleId} 設定不合法：${issues(r.error)}`);
  }
  const states = await moduleStates(ctx, tenant.id);
  const draft = await loadDraft(ctx, tenant);
  const now = new Date().toISOString();
  const changed: { id: string; status: string; autoIncluded: boolean }[] = [];
  for (const id of ids) {
    const existing = states.get(id);
    const isTarget = id === input.moduleId;
    if (existing && existing.status !== "disabled" && !(isTarget && input.config)) continue;
    const m = getModule(id)!;
    const config = isTarget && input.config ? input.config : (draft.moduleSettings?.[id] ?? {});
    const status = await adjustModuleStatus(ctx.store, tenant.id, id, m.settingsSchema.safeParse(config).success ? "enabled" : "pending_setup");
    await ctx.store.upsertTenantModule({ tenant_id: tenant.id, module_id: id, status, config: {}, enabled_at: now });
    changed.push({ id, status, autoIncluded: !isTarget });
  }
  // 設定一律進草稿，發布後才對外生效
  if (input.config) {
    const cfg = input.config;
    await mutateDraft(ctx, tenant, (d) => {
      d.moduleSettings = { ...(d.moduleSettings ?? {}), [input.moduleId]: cfg };
    });
  }
  await audit(ctx, tenant.id, "module.enable", { moduleId: input.moduleId, changed });
  const pending = changed.filter((c) => c.status === "pending_setup").map((c) => c.id);
  const shopPending = pending.includes("shop");
  return {
    moduleId: input.moduleId,
    changed,
    alreadyEnabled: changed.length === 0,
    sectionTypes: target.sectionTypes.map((s) => s.type),
    note: pending.length
      ? `下列模組需要設定才會生效：${pending.join(", ")}。${shopPending ? "shop 需由平台擁有者在後台「金流設定」輸入並驗證 PChomePay 憑證（MCP 無法設定金鑰）；在那之前可用 configure_module 開啟線下匯款（offlineTransfer）。" : "請用 configure_module。"}`
      : undefined,
  };
}

export async function disableModule(ctx: ServiceContext, input: { site?: string | null; moduleId: string }) {
  requireScope(ctx, "modules:write");
  const tenant = await resolveTenant(ctx, input.site);
  const states = await moduleStates(ctx, tenant.id);
  const row = states.get(input.moduleId);
  if (!row || row.status === "disabled") throw new ServiceError("invalid", `模組 ${input.moduleId} 本來就沒有啟用`);
  const reason = checkDisable(input.moduleId, activeModuleIds(states));
  if (reason) throw new ServiceError("conflict", reason);
  const m = getModule(input.moduleId)!;
  const types = new Set(m.sectionTypes.map((s) => s.type));
  const draft = await loadDraft(ctx, tenant);
  const used = draft.pages.flatMap((p) => p.sections.filter((s) => types.has(s.type)).map((s) => `${p.path}#${s.id}(${s.type})`));
  if (used.length) {
    throw new ServiceError("conflict", `草稿中仍有此模組的區塊：${used.join(", ")}。請先 remove_section 再停用。`);
  }
  await ctx.store.upsertTenantModule({ ...row, status: "disabled" });
  await audit(ctx, tenant.id, "module.disable", { moduleId: input.moduleId });
  return { moduleId: input.moduleId, status: "disabled", note: "停用立即生效；已發布網站若仍有此模組區塊將不再顯示，請重新發布。" };
}

export async function configureModule(
  ctx: ServiceContext,
  input: { site?: string | null; moduleId: string; config: Record<string, unknown>; replace?: boolean },
) {
  requireScope(ctx, "modules:write");
  const tenant = await resolveTenant(ctx, input.site);
  const m = getModule(input.moduleId);
  if (!m) throw new ServiceError("invalid", `未知模組：${input.moduleId}`);
  const states = await moduleStates(ctx, tenant.id);
  const row = states.get(input.moduleId);
  if (!row || row.status === "disabled") throw new ServiceError("invalid", `模組 ${input.moduleId} 尚未啟用，請先 enable_module`);
  const { result: data } = await mutateDraft(ctx, tenant, (d) => {
    const current = d.moduleSettings?.[input.moduleId] ?? {};
    const merged = input.replace ? input.config : { ...current, ...input.config };
    const r = m.settingsSchema.safeParse(merged);
    if (!r.success) throw new ServiceError("invalid", `模組 ${input.moduleId} 設定不合法：${issues(r.error)}`);
    d.moduleSettings = { ...(d.moduleSettings ?? {}), [input.moduleId]: r.data };
    return r.data;
  });
  const status = await adjustModuleStatus(ctx.store, tenant.id, input.moduleId, "enabled");
  if (row.status !== status) await ctx.store.upsertTenantModule({ ...row, status });
  await audit(ctx, tenant.id, "module.configure", { moduleId: input.moduleId, keys: Object.keys(input.config) });
  return {
    moduleId: input.moduleId,
    status,
    config: data,
    draft: true,
    note: "設定已存入草稿，要 preview_changes → publish_site（confirm: true）後才會對外生效。",
  };
}
