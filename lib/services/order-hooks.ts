import type { Store, TenantRow, OrderRow } from "../store/types";

/**
 * 訂單事件的模組副作用註冊表（沒有任何依賴，避免 orders ↔ 模組循環 import）。
 * 每個 hook 自己要冪等；失敗只記 log，不影響付款／取消流程。
 */
export type HookDeps = { store: Store; sendMail?: (to: string, subject: string, text: string) => Promise<void>; baseUrl: string };
type PaidHook = (deps: HookDeps, tenant: TenantRow, order: OrderRow) => Promise<void>;
/** deps：呼叫端的寄信函式與網址（沒帶時 hook 自己用環境預設） */
export type CancelDeps = { sendMail?: HookDeps["sendMail"]; baseUrl?: string };
type CancelHook = (store: Store, tenant: TenantRow, order: OrderRow, deps?: CancelDeps) => Promise<void>;

const paidHooks: PaidHook[] = [];
const cancelHooks: CancelHook[] = [];

export function registerOrderHooks(h: { paid?: PaidHook; cancelled?: CancelHook }) {
  if (h.paid && !paidHooks.includes(h.paid)) paidHooks.push(h.paid);
  if (h.cancelled && !cancelHooks.includes(h.cancelled)) cancelHooks.push(h.cancelled);
}

export async function runPaidHooks(deps: HookDeps, tenant: TenantRow, order: OrderRow) {
  for (const hook of paidHooks) {
    try {
      await hook(deps, tenant, order);
    } catch (e) {
      console.error("[order.paid hook] 失敗", e instanceof Error ? e.message : e);
    }
  }
}

export async function runCancelHooks(store: Store, tenant: TenantRow, order: OrderRow, deps?: CancelDeps) {
  for (const hook of cancelHooks) {
    try {
      await hook(store, tenant, order, deps);
    } catch (e) {
      console.error("[order.cancel hook] 失敗", e instanceof Error ? e.message : e);
    }
  }
}
