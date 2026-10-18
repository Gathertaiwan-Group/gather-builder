import type { ModuleStatus, Store } from "../store/types";

/**
 * 部分模組的「設定完成」不只看 settingsSchema，還要有已驗證的憑證：
 * - shop：已驗證的 PChomePay 憑證（沒有 → pending_setup，仍可只用線下匯款）
 * - invoice：已驗證的發票憑證（沒有 → pending_setup，不會開票）
 * - ai-chat：平台 env GEMINI_API_KEY（沒有 → pending_setup，前台不顯示客服）
 */
export async function adjustModuleStatus(store: Store, tenantId: string, moduleId: string, status: ModuleStatus): Promise<ModuleStatus> {
  if (status !== "enabled") return status;
  if (moduleId === "shop") {
    const acct = await store.getPaymentAccount(tenantId, "pchomepay");
    return acct?.status === "verified" ? "enabled" : "pending_setup";
  }
  if (moduleId === "invoice") {
    const acct = await store.getInvoiceAccount(tenantId);
    return acct?.status === "verified" ? "enabled" : "pending_setup";
  }
  if (moduleId === "ai-chat") return process.env.GEMINI_API_KEY ? "enabled" : "pending_setup";
  return status;
}
