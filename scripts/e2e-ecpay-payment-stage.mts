// 綠界「金流」stage 實測（只打綠界官方測試環境 payment-stage.ecpay.com.tw，用官方公開測試特店）。
// 測試特店來源：https://developers.ecpay.com.tw/2856/「介接資訊／測試環境」——MerchantID 3002607、HashKey pwFHCqoQZGmho4w6、HashIV EkRm7iFT261dpevs（官方公開測試值）
// 🔴 規則：不跟隨付款頁、不輸入任何卡號；只做到「AioCheckOut 建單成功（stage 回付款頁）」為止。callback 由本腳本以測試金鑰自行簽章模擬。
// 流程（記憶體 Store，不寫任何 DB）：開店（shop、測試網站）→ 存 stage 憑證並「驗證」（QueryTradeInfo 查不存在的訂單，驗回應 CheckMacValue）→
//       預覽結帳選綠界 → 產生 AioCheckOut 表單（驗參數與 CheckMacValue）→ 實際 POST 到 stage（只讀回應，不跟隨）→
//       stage QueryTradeInfo 回查這筆（未付款，回應 CheckMacValue 必須驗得過）→ 模擬「付款成功」通知（正確簽章）→
//       權威回查仍為未付款 → 訂單不變（證明偽造不了）→ 竄改的通知被拒 → 逾期前回查（未付）→ 才取消。
// 用法：npx tsx scripts/e2e-ecpay-payment-stage.mts
process.env.PREVIEW_SECRET ??= "e2e-ecpay-payment-stage-preview-secret";
process.env.PAYMENT_ENC_KEY ??= Buffer.alloc(32, 12).toString("base64");

const { createMemoryStore } = await import("../lib/store/memory");
const { adminActor } = await import("../lib/tokens");
const { createSite } = await import("../lib/services/sites");
const { configureModule } = await import("../lib/services/modules");
const { publishSite } = await import("../lib/services/publish");
const { createProduct, placeOrder } = await import("../lib/services/shop");
const { saveProviderAccount, verifyProviderAccount, startOnlinePayment, handleProviderNotify, expireIfDue, providerClientFor } = await import("../lib/services/orders");
const { ECPAY_STAGE_TEST_MERCHANT, ecpayCheckMac, createEcpayProvider } = await import("../lib/pay/ecpay");
const { payToken } = await import("../lib/pay/notify-token");

let fails = 0;
const check = (cond: unknown, label: string, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) fails++;
};

const T = ECPAY_STAGE_TEST_MERCHANT;
const BASE = "https://gather-builder.vercel.app"; // ReturnURL 只需是公開網址；本腳本不讓 stage 實際送通知（不付款）
const store = createMemoryStore();
const ctx = { actor: adminActor(), store, baseUrl: BASE, previewSecret: process.env.PREVIEW_SECRET! };
const slug = `ecpay-pay-stage-${Date.now().toString(36)}`;

await createSite(ctx, { slug, name: "綠界金流 stage 測試", modules: ["shop"], test: true });
await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, ownerEmail: "gathertaiwan@gmail.com" } });
await publishSite(ctx, { site: slug, confirm: true });
const tenant = (await store.getTenantBySlug(slug))!;
const p = await createProduct(ctx, { site: slug, slug: "tea", name: "測試茶", price: 350, status: "published", confirm: true });

await saveProviderAccount(ctx, { site: slug, provider: "ecpay", appId: T.merchantId, secrets: { hashKey: T.hashKey, hashIv: T.hashIv }, sandbox: true });
try {
  const v = await verifyProviderAccount(ctx, { site: slug, provider: "ecpay" });
  check(v.verified && v.sandbox, "後台「驗證」：stage QueryTradeInfo（查不存在的訂單）回應 CheckMacValue 驗得過");
} catch (e) {
  check(false, "後台「驗證」", e instanceof Error ? e.message : String(e));
}
// 錯的 HashKey 驗證要失敗
{
  const bad = createEcpayProvider({ merchantId: T.merchantId, hashKey: "WRONGKEY00000000", hashIv: T.hashIv, stage: true });
  const r = await bad.verifyCredentials();
  check(!r.ok, "錯的 HashKey → 驗證失敗", r.ok ? "" : r.message.slice(0, 80));
}

// 已發布網站一般訪客：stage 憑證不提供
const contact = { name: "測試客人", email: "gathertaiwan@gmail.com", phone: "0912345678" };
const shipping = { name: "測試客人", phone: "0912345678", address: "台中市西屯區" };
let blocked = false;
try {
  await placeOrder({ store, baseUrl: BASE }, { tenant, member: null, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "ecpay" } });
} catch {
  blocked = true;
}
check(blocked, "已發布網站一般訪客不能選 stage 綠界（只有預覽結帳可用）");

const { order, accessKey } = await placeOrder({ store, baseUrl: BASE }, { tenant, member: null, allowSandbox: true, data: { items: [{ productId: p.id, qty: 1 }], contact, shipping, paymentMethod: "ecpay" } });
const pay = await startOnlinePayment({ store, baseUrl: BASE }, { tenant, order, accessKey });
check(pay.kind === "form", "建單：產生 AioCheckOut 表單");
if (pay.kind !== "form") process.exit(1);
const f = pay.fields;
check(pay.action === "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5", "表單送往 stage AioCheckOut/V5", pay.action);
check(f.MerchantID === T.merchantId && f.MerchantTradeNo === pay.gatewayOrderNo && /^[A-Za-z0-9]{1,20}$/.test(f.MerchantTradeNo!), "MerchantID／MerchantTradeNo（英數 ≤20）", f.MerchantTradeNo);
check(f.TotalAmount === String(order.total) && f.PaymentType === "aio" && f.ChoosePayment === "Credit" && f.EncryptType === "1", "TotalAmount／PaymentType／ChoosePayment=Credit／EncryptType=1", `${f.TotalAmount} ${f.ChoosePayment}`);
check(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(f.MerchantTradeDate!), "MerchantTradeDate yyyy/MM/dd HH:mm:ss（台北）", f.MerchantTradeDate);
check(f.ReturnURL!.startsWith(`${BASE}/api/pay/ecpay/notify/${tenant.id}?p=`), "ReturnURL＝帶租戶與 token 的 notify", f.ReturnURL!.slice(0, 80));
const { CheckMacValue, ...rest } = f;
check(CheckMacValue === ecpayCheckMac(rest, T.hashKey, T.hashIv), "CheckMacValue 正確（SHA256，官方演算法）");

// 實際 POST 到 stage（只讀回應，不跟隨任何付款頁）
const res = await fetch(pay.action, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f).toString(), redirect: "manual" });
const html = await res.text();
const looksError = /CheckMacValue|Error|錯誤|失敗/i.test(html.slice(0, 2000)) && !/信用卡|付款/.test(html.slice(0, 4000));
check(res.status === 200 && !looksError, `stage 接受建單（HTTP ${res.status}，回付款頁）`, html.replace(/\s+/g, " ").slice(0, 120));

// stage 權威回查（未付款）
const prov = (await providerClientFor(store, tenant.id, "ecpay"))! as ReturnType<typeof createEcpayProvider>;
const q = await prov.queryRaw(pay.gatewayOrderNo);
check(!!q, "stage QueryTradeInfo 有回應且 CheckMacValue 驗得過", q ? `TradeStatus=${q.TradeStatus} TradeAmt=${q.TradeAmt}` : "null");
const aq = await prov.queryPayment({ gatewayOrderNo: pay.gatewayOrderNo, amount: order.total });
check(aq?.state === "pending", "回查判讀：未付款（pending）", aq?.statusText ?? "null");

// 模擬「付款成功」通知（以官方測試金鑰正確簽章）→ 權威回查仍未付 → 不改狀態
const payment = (await store.getPaymentByGatewayNo(pay.gatewayOrderNo))!;
const cb: Record<string, string> = { MerchantID: T.merchantId, MerchantTradeNo: pay.gatewayOrderNo, RtnCode: "1", RtnMsg: "交易成功", TradeAmt: String(order.total), TradeNo: "2410190000000001", PaymentType: "Credit_CreditCard", PaymentDate: "2026/10/19 12:00:00", SimulatePaid: "0", CustomField1: "" };
const body = new URLSearchParams({ ...cb, CheckMacValue: ecpayCheckMac(cb, T.hashKey, T.hashIv) }).toString();
const deps = { store, baseUrl: BASE };
const n1 = await handleProviderNotify(deps, { provider: "ecpay", tenantId: tenant.id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody: body, contentType: "application/x-www-form-urlencoded" });
check(n1.body === "1|OK" && n1.outcome.startsWith("not_paid"), "偽造的付款成功通知（簽章正確）→ 權威回查未付 → 不改狀態、回 1|OK", n1.outcome);
check((await store.getOrderById(tenant.id, order.id))!.status === "pending_payment", "訂單仍是待付款");
const tampered = body.replace(/CheckMacValue=([0-9A-F])/, (_m, c) => `CheckMacValue=${c === "A" ? "B" : "A"}`);
const n2 = await handleProviderNotify(deps, { provider: "ecpay", tenantId: tenant.id, paymentId: payment.id, token: payToken("notify", payment.id), rawBody: tampered, contentType: "application/x-www-form-urlencoded" });
check(n2.body === "0|CheckMacValueError", "竄改的通知 → 0|CheckMacValueError", n2.outcome);

// 逾期前回查（stage 仍未付）→ 才取消
const after = await expireIfDue(store, order, Date.now() + 3 * 3600_000, deps);
check(after.status === "cancelled", "逾期前先回查（未付）→ 取消", after.status);

console.log(fails ? `\n${fails} 項失敗` : "\n全部通過");
process.exit(fails ? 1 : 0);
