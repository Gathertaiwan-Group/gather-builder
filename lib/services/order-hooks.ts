import type { Mailer } from "../mail";
import type { Store, TenantRow, OrderRow } from "../store/types";

/**
 * 訂單事件的模組副作用註冊表（沒有任何依賴，避免 orders ↔ 模組循環 import）。
 * 每個 hook 自己要冪等（重跑不會重複開通／重複寄確認）。
 *
 * 2026-10 審查 M2：hook 失敗不再只記 log——寫 builder_hook_failures（訂單 × hook × 事件 一列），
 * 每日 cron 與讀取訂單時補做（retryHookFailures，冪等），連續失敗 HOOK_ALERT_AT 次寄店主警示（只寄一次）。
 */
export type HookDeps = { store: Store; sendMail?: Mailer; baseUrl: string };
type PaidHook = (deps: HookDeps, tenant: TenantRow, order: OrderRow) => Promise<void>;
/** deps：呼叫端的寄信函式與網址（沒帶時 hook 自己用環境預設） */
export type CancelDeps = { sendMail?: HookDeps["sendMail"]; baseUrl?: string };
type CancelHook = (store: Store, tenant: TenantRow, order: OrderRow, deps?: CancelDeps) => Promise<void>;

interface HookEntry {
  name: string;
  paid?: PaidHook;
  cancelled?: CancelHook;
}

const hooks: HookEntry[] = [];

/** 連續失敗幾次寄店主警示 */
export const HOOK_ALERT_AT = 3;
/** 超過這個次數不再自動補做（仍保留紀錄，需人工處理） */
export const HOOK_MAX_ATTEMPTS = 20;

export function registerOrderHooks(h: HookEntry) {
  if (!/^[a-z0-9_-]{1,40}$/.test(h.name)) throw new Error(`hook name 不合法：${h.name}`);
  const i = hooks.findIndex((x) => x.name === h.name);
  if (i >= 0) hooks[i] = h;
  else hooks.push(h);
}

export function registeredHookNames() {
  return hooks.map((h) => h.name);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

async function recordFailure(store: Store, tenant: TenantRow, order: OrderRow, name: string, event: "paid" | "cancelled", e: unknown) {
  console.error(`[order.${event} hook:${name}] 失敗 order=${order.order_no}`, errText(e));
  try {
    await store.recordHookFailure({ tenant_id: tenant.id, order_id: order.id, hook: name, event, error: errText(e) });
  } catch (e2) {
    console.error(`[order.${event} hook:${name}] 連失敗紀錄都寫不進去`, errText(e2));
  }
}

export async function runPaidHooks(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  for (const h of hooks) {
    if (!h.paid) continue;
    try {
      await h.paid(deps, tenant, order);
    } catch (e) {
      await recordFailure(deps.store, tenant, order, h.name, "paid", e);
    }
  }
}

export async function runCancelHooks(store: Store, tenant: TenantRow, order: OrderRow, deps?: CancelDeps) {
  for (const h of hooks) {
    if (!h.cancelled) continue;
    try {
      await h.cancelled(store, tenant, order, deps);
    } catch (e) {
      await recordFailure(store, tenant, order, h.name, "cancelled", e);
    }
  }
}

/**
 * 補做失敗的 hook（冪等）：訂單狀態仍符合事件才重跑（paid hook 要求訂單仍為已付款／已出貨且不是 sandbox；
 * cancel hook 要求訂單已取消），否則標為已解決（不再適用）。成功 → resolved；失敗 → attempts+1，達門檻警示店主一次。
 * 每日 cron 跑全部；讀取訂單（get_order、訂單頁）時只跑該訂單。
 */
export async function retryHookFailures(
  deps: HookDeps & { alert?: (tenant: TenantRow, order: OrderRow, hook: string, event: string, attempts: number, error: string) => Promise<void> },
  opts: { orderId?: string; tenantId?: string; limit?: number } = {},
): Promise<{ scanned: number; resolved: number; failed: number }> {
  const open = await deps.store.listOpenHookFailures({ orderId: opts.orderId, tenantId: opts.tenantId, limit: opts.limit ?? 100, maxAttempts: HOOK_MAX_ATTEMPTS });
  let resolved = 0;
  let failed = 0;
  for (const f of open) {
    const tenant = await deps.store.getTenantById(f.tenant_id);
    const order = tenant ? await deps.store.getOrderById(tenant.id, f.order_id) : null;
    const h = hooks.find((x) => x.name === f.hook);
    const fn = f.event === "paid" ? h?.paid : h?.cancelled;
    if (!tenant || !order || !fn) {
      await deps.store.resolveHookFailure(f.id, "obsolete");
      resolved++;
      continue;
    }
    const applicable = f.event === "paid" ? (order.status === "paid" || order.status === "fulfilled") && !order.payment_sandbox : order.status === "cancelled";
    if (!applicable) {
      await deps.store.resolveHookFailure(f.id, "obsolete");
      resolved++;
      continue;
    }
    try {
      if (f.event === "paid") await (fn as PaidHook)(deps, tenant, order);
      else await (fn as CancelHook)(deps.store, tenant, order, { sendMail: deps.sendMail, baseUrl: deps.baseUrl });
      await deps.store.resolveHookFailure(f.id, "retried");
      await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:hooks", action: "hook.retry_ok", payload: { orderNo: order.order_no, hook: f.hook, event: f.event, attempts: f.attempts } });
      resolved++;
    } catch (e) {
      failed++;
      const attempts = await deps.store.bumpHookFailure(f.id, errText(e));
      console.error(`[hook retry:${f.hook}] 仍失敗（第 ${attempts} 次）order=${order.order_no}`, errText(e));
      if (attempts >= HOOK_ALERT_AT && (await deps.store.markHookFailureAlerted(f.id)) && deps.alert) {
        await deps.alert(tenant, order, f.hook, f.event, attempts, errText(e)).catch(() => undefined);
      }
    }
  }
  return { scanned: open.length, resolved, failed };
}
