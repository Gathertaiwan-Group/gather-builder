import { decryptSecret } from "../secretbox";
import type { PaymentAccountRow } from "../store/types";
import { classifyPchomepayQuery, createPchomepayClient, type PchomepayClient } from "./pchomepay";
import { createNewebpayProvider } from "./newebpay";
import { createEcpayProvider } from "./ecpay";
import { createLinepayProvider } from "./linepay";
import { createBlackcatProvider } from "./blackcat";
import { createPayuniProvider } from "./payuni";
import type { FetchLike, PaymentProvider, ProviderId } from "./types";

/**
 * 從 DB 憑證建 provider（解密只在 server 記憶體中）。葉節點：只依賴 lib/pay、secretbox，不 import services（避免循環）。
 *
 * 憑證存法（builder_payment_accounts）：app_id＝商店代號（PChomePay APP ID／藍新、綠界 MerchantID／LINE Pay Channel ID／黑貓 CUST_ID／PAYUNi MerID）；
 * secret_enc＝secretbox 密文（PChomePay 為 secret 原字串；其他家為 JSON：{hashKey,hashIv}／{channelSecret}／{apiPassword,refundPassword?,acquirerType?}），AAD 綁 tenant_id。
 * sandbox＝測試環境（藍新 ccore、綠界 stage、LINE Pay sandbox、黑貓測試機、PAYUNi sandbox）。
 */
export type ProviderSecret =
  | { provider: "pchomepay"; secret: string }
  | { provider: "newebpay" | "ecpay" | "payuni"; hashKey: string; hashIv: string }
  | { provider: "linepay"; channelSecret: string }
  | { provider: "blackcat"; apiPassword: string; refundPassword?: string; acquirerType?: "esun" | "chinatrust" | "payuni" };

export function decodeSecret(acct: PaymentAccountRow, tenantId: string): ProviderSecret {
  const plain = decryptSecret(acct.secret_enc, tenantId);
  if (acct.provider === "pchomepay") return { provider: "pchomepay", secret: plain };
  const o = JSON.parse(plain) as Record<string, string>;
  switch (acct.provider) {
    case "newebpay":
    case "ecpay":
    case "payuni":
      return { provider: acct.provider, hashKey: o.hashKey ?? "", hashIv: o.hashIv ?? "" };
    case "linepay":
      return { provider: "linepay", channelSecret: o.channelSecret ?? "" };
    case "blackcat":
      return { provider: "blackcat", apiPassword: o.apiPassword ?? "", refundPassword: o.refundPassword || undefined, acquirerType: (o.acquirerType as "payuni") || undefined };
  }
}

/** PChomePay 實作 PaymentProvider（行為與 lib/services/orders.ts 的既有流程相同：建單 /v1/payment、權威回查 /v1/payment/{id}） */
export function pchomepayProvider(client: Pick<PchomepayClient, "verify" | "createPayment" | "queryPayment">, sandbox: boolean): PaymentProvider {
  return {
    id: "pchomepay",
    sandbox,
    async verifyCredentials() {
      return client.verify();
    },
    async createPayment(input) {
      const r = await client.createPayment({
        orderNo: input.gatewayOrderNo,
        amount: input.amount,
        itemName: input.itemName,
        itemUrl: input.cancelUrl,
        returnUrl: input.returnUrl,
        notifyUrl: input.notifyUrl,
        buyerEmail: input.buyerEmail,
        holdHours: (input.expireMinutes ?? 0) / 60,
      });
      return r ? { kind: "redirect", url: r.paymentUrl } : null;
    },
    async queryPayment({ gatewayOrderNo }) {
      const q = await client.queryPayment(gatewayOrderNo);
      if (!q) return null;
      return { state: classifyPchomepayQuery(q), amount: q.amount, statusText: `status=${q.status ?? "-"} status_code=${q.status_code ?? "-"}`, raw: q.raw };
    },
    // 沒有 refund：PChomePay 未公開退款 API，維持「提示到 PChomePay 商家後台人工退款」
  };
}

export function providerFromAccount(acct: PaymentAccountRow, tenantId: string, fetchImpl?: FetchLike): PaymentProvider {
  const s = decodeSecret(acct, tenantId);
  switch (s.provider) {
    case "pchomepay":
      return pchomepayProvider(createPchomepayClient({ cacheKey: tenantId, appId: acct.app_id, secret: s.secret, sandbox: acct.sandbox }, fetchImpl), acct.sandbox);
    case "newebpay":
      return createNewebpayProvider({ merchantId: acct.app_id, hashKey: s.hashKey, hashIv: s.hashIv, test: acct.sandbox }, fetchImpl);
    case "ecpay":
      return createEcpayProvider({ merchantId: acct.app_id, hashKey: s.hashKey, hashIv: s.hashIv, stage: acct.sandbox }, fetchImpl);
    case "payuni":
      return createPayuniProvider({ merId: acct.app_id, hashKey: s.hashKey, hashIv: s.hashIv, sandbox: acct.sandbox }, fetchImpl);
    case "linepay":
      return createLinepayProvider({ channelId: acct.app_id, channelSecret: s.channelSecret, sandbox: acct.sandbox }, fetchImpl);
    case "blackcat":
      return createBlackcatProvider({ custId: acct.app_id, apiPassword: s.apiPassword, refundPassword: s.refundPassword, acquirerType: s.acquirerType, test: acct.sandbox, cacheKey: tenantId }, fetchImpl);
  }
}

export const ONLINE_PROVIDERS: ProviderId[] = ["pchomepay", "newebpay", "ecpay", "linepay", "blackcat", "payuni"];
