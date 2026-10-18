import type { ModuleStatus, Store } from "../store/types";

/**
 * shop 模組的「設定完成」不只看 settingsSchema：還要有已驗證的 PChomePay 憑證。
 * 沒有 → pending_setup（區塊照常顯示，結帳只提供已開放的線下匯款）。
 */
export async function adjustModuleStatus(store: Store, tenantId: string, moduleId: string, status: ModuleStatus): Promise<ModuleStatus> {
  if (moduleId !== "shop" || status !== "enabled") return status;
  const acct = await store.getPaymentAccount(tenantId, "pchomepay");
  return acct?.status === "verified" ? "enabled" : "pending_setup";
}
