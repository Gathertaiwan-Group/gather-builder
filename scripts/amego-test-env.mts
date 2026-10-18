// Amego 官方公開「測試公司」帳號的連線驗證（只打官方文件公布的測試帳號，不碰任何真實商家）。
// 來源：https://invoice.amego.tw/api_doc/ 「測試公司」欄：統編 12345678、App Key sHeq7t8G1wiQvhAuIM27（官方公開測試值）
//       測試後台 https://invoice.amego.tw/ 帳號 test@amego.tw（測試環境有限公司；測試環境不會主動寄信）
// 用法：npx tsx scripts/amego-test-env.mts [--issue]   （--issue 會在「測試公司」開一張測試發票並立即作廢）
import { createAmegoProvider } from "../lib/invoice/amego";

const p = createAmegoProvider({ sellerTaxId: "12345678", appKey: "sHeq7t8G1wiQvhAuIM27", relayUrl: null, relaySecret: null });
const v = await p.verify();
console.log("verify(invoice_query 不存在的訂單 → 預期 code 71)：", v.ok ? "OK" : v);
if (process.argv.includes("--issue")) {
  const orderNo = `GBTEST${Date.now()}`;
  const r = await p.issue({ orderNo, total: 120, items: [{ name: "測試商品", qty: 1, unitPrice: 100 }, { name: "運費", qty: 1, unitPrice: 20 }], buyerEmail: "", buyerName: "測試", request: { type: "member" } });
  console.log("issue：", r.ok ? { invoiceNo: r.invoiceNo, invoiceDate: r.invoiceDate } : r);
  const q = await p.query(orderNo);
  console.log("query：", q.ok ? (q.found ? { found: true, invoiceNo: q.invoiceNo } : { found: false }) : q);
  if (r.ok) {
    const again = await p.issue({ orderNo, total: 120, items: [{ name: "測試商品", qty: 1, unitPrice: 120 }], buyerEmail: "", buyerName: "測試", request: { type: "member" } });
    console.log("重複 OrderId 再開：", again.ok ? "（竟然成功！）" : { duplicate: "duplicate" in again ? again.duplicate : undefined, code: again.code, message: again.message });
    const vo = await p.void({ invoiceNo: r.invoiceNo, reason: "測試作廢" });
    console.log("void：", vo.ok ? "OK" : vo);
  }
  // 折讓：另開一張再折讓 50（含稅）
  const o2 = `GBTEST${Date.now()}A`;
  const r2 = await p.issue({ orderNo: o2, total: 210, items: [{ name: "測試商品", qty: 2, unitPrice: 105 }], buyerEmail: "", buyerName: "測試", request: { type: "member" } });
  if (r2.ok) {
    const al = await p.allowance({ allowanceNo: `AL${Date.now().toString(36).toUpperCase()}`.slice(0, 16), invoiceNo: r2.invoiceNo, invoiceDate: r2.invoiceDate, amount: 50, buyerEmail: "", buyerName: "測試", buyerTaxId: null, description: "測試折讓" });
    console.log("allowance：", r2.invoiceNo, al.ok ? "OK" : al);
  }
}
