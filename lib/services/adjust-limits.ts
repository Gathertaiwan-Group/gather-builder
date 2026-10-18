import type { Store, TenantRow } from "../store/types";
import { ServiceError, audit, resolveTenant, type ServiceContext } from "./context";
import { taipeiDayStartIso } from "./loyalty-time";

/**
 * 第七批審查 L4：店主手動調整點數／儲值金的上限。
 * - 上限只能由平台後台（admin actor）設定，存在 builder_tenants.settings.adjustLimits；
 *   模組設定裡的 adjustMaxPerCall／adjustMaxPerDay（modules:write 可改）只能把上限「調低」，不能調高。
 * - 每日上限以 DB 原子累計（builder_quota_take，條件式 +amount ≤ limit），兩個同時送出的調整不會一起超過。
 */
export type AdjustLedger = "points" | "wallet";
export const ADJUST_DEFAULTS: Record<AdjustLedger, { perCall: number; perDay: number }> = {
  points: { perCall: 5_000, perDay: 20_000 },
  wallet: { perCall: 3_000, perDay: 10_000 },
};

type Limits = { perCall: number; perDay: number };

function adminLimits(tenant: TenantRow, ledger: AdjustLedger): Partial<Limits> {
  const raw = (tenant.settings as { adjustLimits?: Record<string, unknown> } | null)?.adjustLimits?.[ledger] as Partial<Limits> | undefined;
  const ok = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined);
  return { perCall: ok(raw?.perCall), perDay: ok(raw?.perDay) };
}

export function effectiveAdjustLimits(tenant: TenantRow, ledger: AdjustLedger, moduleSettings: { adjustMaxPerCall?: number; adjustMaxPerDay?: number }): Limits {
  const a = adminLimits(tenant, ledger);
  const perCall = a.perCall ?? ADJUST_DEFAULTS[ledger].perCall;
  const perDay = a.perDay ?? ADJUST_DEFAULTS[ledger].perDay;
  return {
    perCall: moduleSettings.adjustMaxPerCall ? Math.min(perCall, moduleSettings.adjustMaxPerCall) : perCall,
    perDay: moduleSettings.adjustMaxPerDay ? Math.min(perDay, moduleSettings.adjustMaxPerDay) : perDay,
  };
}

/** 原子扣今日額度（台北日）：成功回 true；會超過上限回 false（什麼都不扣） */
export async function takeAdjustQuota(store: Store, tenant: TenantRow, ledger: AdjustLedger, amount: number, perDay: number): Promise<{ allowed: boolean; total: number }> {
  return store.quotaTake(`adjust-quota:${ledger}:${tenant.id}`, "day", taipeiDayStartIso(), Math.abs(amount), perDay);
}

/** 平台後台設定上限（只限 admin actor；MCP 不提供） */
export async function setAdjustLimits(ctx: ServiceContext, input: { site: string; ledger: AdjustLedger; perCall: number; perDay: number }) {
  if (ctx.actor.kind !== "admin") throw new ServiceError("forbidden", "手動調整上限只能由平台擁有者在後台設定");
  if (input.ledger !== "points" && input.ledger !== "wallet") throw new ServiceError("invalid", "ledger 需為 points 或 wallet");
  const max = input.ledger === "points" ? 1_000_000 : 1_000_000;
  for (const [k, v] of [["單次上限", input.perCall], ["每日上限", input.perDay]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > max * 10) throw new ServiceError("invalid", `${k}需為 1–${(max * 10).toLocaleString()} 的整數`);
  }
  if (input.perCall > input.perDay) throw new ServiceError("invalid", "單次上限不能大於每日上限");
  const tenant = await resolveTenant(ctx, input.site);
  const settings = { ...(tenant.settings ?? {}) } as Record<string, unknown>;
  const cur = (settings.adjustLimits ?? {}) as Record<string, unknown>;
  settings.adjustLimits = { ...cur, [input.ledger]: { perCall: input.perCall, perDay: input.perDay } };
  await ctx.store.updateTenant(tenant.id, { settings });
  await audit(ctx, tenant.id, "adjust_limits.set", { ledger: input.ledger, perCall: input.perCall, perDay: input.perDay });
  return { ledger: input.ledger, perCall: input.perCall, perDay: input.perDay };
}
