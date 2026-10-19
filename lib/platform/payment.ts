import { createPchomepayClient, type PchomepayClient } from "../pay/pchomepay";

/**
 * 平台自己的金流帳號（向店主收建置費與月費）：PChomePay，env 設定。
 * - PLATFORM_PCHOMEPAY_APP_ID／PLATFORM_PCHOMEPAY_SECRET／PLATFORM_PCHOMEPAY_SANDBOX（"true"＝測試環境）
 * - 🔴 沒設＝/build 只能看價格、結帳顯示「尚未開放付款」。正式金鑰由老闆決定後才設定。
 * - 🔴 sandbox 只限測試：sandbox 結帳只接受本機（localhost）或帶平台測試簽章的請求，開出來的一律是 is_test 網站。
 */
export interface PlatformPayConfig {
  appId: string;
  secret: string;
  sandbox: boolean;
}

export function platformPayConfig(env: Record<string, string | undefined> = process.env): PlatformPayConfig | null {
  const appId = env.PLATFORM_PCHOMEPAY_APP_ID?.trim();
  const secret = env.PLATFORM_PCHOMEPAY_SECRET?.trim();
  if (!appId || !secret) return null;
  return { appId, secret, sandbox: env.PLATFORM_PCHOMEPAY_SANDBOX === "true" };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 回查／建單用的 client；sandbox 必須等於訂單建立時的環境（回查環境＝建單環境） */
export function platformPayClient(sandbox: boolean, fetchImpl?: FetchLike, env: Record<string, string | undefined> = process.env): PchomepayClient | null {
  const cfg = platformPayConfig(env);
  if (!cfg || cfg.sandbox !== sandbox) return null;
  return createPchomepayClient({ cacheKey: `platform:${cfg.sandbox ? "s" : "p"}`, appId: cfg.appId, secret: cfg.secret, sandbox: cfg.sandbox }, fetchImpl);
}
