import { createHash } from "node:crypto";
import { taipeiYmd, type InvoiceProvider } from "./provider";

/**
 * 模擬供應商：只給 is_test 測試租戶（e2e 用），不連任何外部服務、不產生真實發票。
 * 號碼由訂單編號決定（同一訂單永遠同一號），格式 MK＋8 碼數字，一看就知道是假的。
 */
export function mockInvoiceNo(orderNo: string): string {
  const n = parseInt(createHash("sha256").update(orderNo).digest("hex").slice(0, 8), 16) % 100_000_000;
  return `MK${String(n).padStart(8, "0")}`;
}

export function createMockProvider(): InvoiceProvider {
  return {
    id: "mock",
    async verify() {
      return { ok: true };
    },
    async issue(input) {
      return { ok: true, invoiceNo: mockInvoiceNo(input.orderNo), randomNumber: "0000", invoiceDate: taipeiYmd(), raw: { mock: true, orderNo: input.orderNo, total: input.total } };
    },
    async query() {
      return { ok: true, found: false };
    },
    async void(input) {
      return { ok: true, raw: { mock: true, voided: input.invoiceNo } };
    },
    async allowance(input) {
      return { ok: true, raw: { mock: true, allowance: input.allowanceNo, amount: input.amount } };
    },
  };
}
