import type { ModuleStatus, Store } from "../store/types";

/**
 * 部分模組的「設定完成」不只看 settingsSchema，還要有已驗證的憑證：
 * - shop：任何一家已驗證的金流憑證（沒有 → pending_setup，仍可只用線下匯款）
 * - invoice：已驗證的發票憑證（沒有 → pending_setup，不會開票）
 * - ai-chat：平台 env GEMINI_API_KEY（沒有 → pending_setup，前台不顯示客服）
 */
export async function adjustModuleStatus(store: Store, tenantId: string, moduleId: string, status: ModuleStatus): Promise<ModuleStatus> {
  if (status !== "enabled") return status;
  if (moduleId === "shop") {
    // 第七批：任何一家已驗證的金流憑證即可（PChomePay、藍新、綠界、LINE Pay、黑貓、PAYUNi）
    return (await store.listPaymentAccounts(tenantId)).some((a) => a.status === "verified") ? "enabled" : "pending_setup";
  }
  if (moduleId === "invoice") {
    const acct = await store.getInvoiceAccount(tenantId);
    return acct?.status === "verified" ? "enabled" : "pending_setup";
  }
  if (moduleId === "subscriptions") {
    // 第七批：需要已驗證的藍新憑證（信用卡定期定額）
    const acct = await store.getPaymentAccount(tenantId, "newebpay");
    return acct?.status === "verified" ? "enabled" : "pending_setup";
  }
  if (moduleId === "ai-chat") return process.env.GEMINI_API_KEY ? "enabled" : "pending_setup";
  return status;
}
