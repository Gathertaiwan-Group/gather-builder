// 綠界物流 stage 端到端（只打綠界官方測試環境 logistics-stage.ecpay.com.tw，用官方公開測試特店）。
// 測試特店來源：https://developers.ecpay.com.tw/?p=7398「測試介接資訊」——C2C：MerchantID 2000933、HashKey XBERn1YOvpM9nfZc、HashIV h1ONHk4P4yqbl5LK（官方公開測試值）
// 測試門市來源：https://developers.ecpay.com.tw/?p=8809「門市訂單建立」——7-ELEVEN 131386、全家 006598
// 流程（記憶體 Store，不寫任何 DB）：開店＋shipping 模組 → 產生電子地圖表單並實際 POST 到 stage 地圖 → 模擬地圖回傳門市 →
//       結帳（超商取貨）→ 標記已收款 → create_shipment 打 stage Express/Create 拿 AllPayLogisticsID →
//       模擬綠界狀態通知（正確 CheckMacValue）→ 出貨單／訂單狀態更新；竄改的通知被拒。
// 用法：npx tsx scripts/e2e-ecpay-stage.mts
process.env.PREVIEW_SECRET ??= "e2e-ecpay-stage-preview-secret";
process.env.PAYMENT_ENC_KEY ??= Buffer.alloc(32, 11).toString("base64");

const { createMemoryStore } = await import("../lib/store/memory");
const { adminActor } = await import("../lib/tokens");
const { createSite } = await import("../lib/services/sites");
const { configureModule, enableModule } = await import("../lib/services/modules");
const { publishSite } = await import("../lib/services/publish");
const { createProduct, placeOrder } = await import("../lib/services/shop");
const { markOrderPaid } = await import("../lib/services/orders");
const { saveShippingAccount, startCvsSelection, handleCvsMapCallback, createShipment, handleLogisticsNotify, getShipment } = await import("../lib/services/shipping");
const { ECPAY_STAGE_TEST_MERCHANTS, checkMacValue } = await import("../lib/shipping/ecpay");

let fails = 0;
const check = (cond: unknown, label: string, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) fails++;
};

const T = ECPAY_STAGE_TEST_MERCHANTS.C2C;
const BASE = "https://gather-builder.vercel.app"; // ServerReplyURL 只需是公開網址；stage 不會模擬狀態通知（官方文件）
const store = createMemoryStore();
const ctx = { actor: adminActor(), store, baseUrl: BASE, previewSecret: process.env.PREVIEW_SECRET! };
const slug = `ecpay-stage-${Date.now().toString(36)}`;

await createSite(ctx, { slug, name: "綠界 stage 測試", modules: ["shop"], test: true });
await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" } } });
await enableModule(ctx, {
  site: slug,
  moduleId: "shipping",
  config: { methods: [{ id: "seven", type: "cvs", provider: "ecpay", subType: "UNIMARTC2C", label: "7-11 交貨便", fee: 60 }], sender: { name: "林店長", cellPhone: "0911222333" }, goodsName: "測試商品" },
});
await saveShippingAccount(ctx, { site: slug, merchantId: T.merchantId, hashKey: T.hashKey, hashIv: T.hashIv, stage: true, kind: "C2C" });
await publishSite(ctx, { site: slug, confirm: true });
const tenant = (await store.getTenantBySlug(slug))!;
const prod = await createProduct(ctx, { site: slug, slug: "item", name: "測試商品", price: 199, status: "published", confirm: true });

// 1) 電子地圖
const start = await startCvsSelection(store, tenant, { methodId: "seven", baseUrl: BASE, mobile: false, allowStage: true });
check(start.form.action === "https://logistics-stage.ecpay.com.tw/Express/map", "電子地圖網址＝stage /Express/map", start.form.action);
check(start.form.fields.MerchantID === "2000933" && start.form.fields.LogisticsType === "CVS" && start.form.fields.LogisticsSubType === "UNIMARTC2C" && start.form.fields.IsCollection === "N", "地圖參數 MerchantID／LogisticsType／SubType／IsCollection");
check(start.form.fields.ServerReplyURL === `${BASE}/api/ship/ecpay/map/${tenant.id}` && /^[A-Za-z0-9]{20}$/.test(start.form.fields.MerchantTradeNo!), "ServerReplyURL 指向本平台、MerchantTradeNo 20 碼隨機");
const mapRes = await fetch(start.form.action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(start.form.fields).toString(), redirect: "manual" });
const mapHtml = await mapRes.text();
// 綠界接受參數後回一個自動送出的表單，把瀏覽器帶往超商（stage 為模擬）地圖；參數錯誤時會回錯誤訊息而不是這個表單
const posted = Object.fromEntries([...mapHtml.matchAll(/name=["']?(\w+)["']?[^>]*value=["']([^"']*)["']/g)].map((m) => [m[1], m[2]]));
check(mapRes.status === 200 && /id="PostForm"/.test(mapHtml) && posted.LogisticsSubType === "UNIMARTC2C", "實際 POST 到 stage 電子地圖：綠界接受參數並回傳導向門市地圖的表單（不點選）", `HTTP ${mapRes.status} → ${posted.url ?? "?"}`);

// 2) 模擬地圖回傳（stage 固定門市；沒有解析到時用官方測試門市 131386）
const cb = await handleCvsMapCallback(store, tenant.id, {
  MerchantID: T.merchantId,
  MerchantTradeNo: start.form.fields.MerchantTradeNo!,
  LogisticsSubType: "UNIMARTC2C",
  CVSStoreID: posted.CVSStoreID || "131386",
  CVSStoreName: posted.CVSStoreName || "測試門市",
  CVSAddress: posted.CVSAddress || "測試地址",
  CVSOutSide: "0",
});
check(cb.ok && !!cb.selectionId, "地圖回傳寫回門市（綁定這次結帳）", cb.message);

// 3) 結帳 → 收款
const { order } = await placeOrder(
  { store, baseUrl: BASE },
  { tenant, member: null, allowSandbox: true, cvsBinding: start.binding, data: { items: [{ productId: prod.id, qty: 1 }], contact: { name: "王小明", email: "stage-test@example.com", phone: "0912345678" }, shipping: { name: "王小明", phone: "0912345678", address: "超商取貨" }, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: cb.selectionId! } },
);
check(order.shipping_fee === 60 && order.total === 259 && order.shipping_choice?.store?.id, "結帳：運費 server 計價 60、門市寫入訂單", `${order.order_no} total=${order.total} store=${order.shipping_choice?.store?.id}`);
await markOrderPaid(ctx, { site: slug, orderNo: order.order_no, confirm: true });

// 4) 建立 stage 物流單
const sh = await createShipment(ctx, { site: slug, orderNo: order.order_no, confirm: true });
check(sh.provider === "ecpay" && sh.stage && !!sh.logisticsId, "create_shipment → stage Express/Create 成功取得 AllPayLogisticsID", `logistics_id=${sh.logisticsId} tracking=${sh.trackingNo} validation=${sh.validationNo}`);

// 5) 模擬狀態通知
const row = (await store.getActiveShipmentByOrder(tenant.id, order.id))!;
const notify: Record<string, string> = { MerchantID: T.merchantId, MerchantTradeNo: row.merchant_trade_no!, RtnCode: "2030", RtnMsg: "商品已送至物流中心", AllPayLogisticsID: row.logistics_id!, LogisticsType: "CVS", LogisticsSubType: "UNIMARTC2C", GoodsAmount: "259", UpdateStatusDate: "2026/10/19 10:00:00", ReceiverName: "王小明", ReceiverPhone: "", ReceiverCellPhone: "0912345678", ReceiverEmail: "stage-test@example.com", ReceiverAddress: "", CVSPaymentNo: row.tracking_no ?? "", CVSValidationNo: row.validation_no ?? "", BookingNote: "" };
const bad = await handleLogisticsNotify({ store, baseUrl: BASE }, { tenantId: tenant.id, rawBody: new URLSearchParams({ ...notify, CheckMacValue: "0".repeat(32) }).toString() });
check(bad.status === 400 && bad.body === "0|CheckMacValueError", "竄改的狀態通知（CheckMacValue 錯）→ 拒絕", bad.body);
const good = await handleLogisticsNotify({ store, baseUrl: BASE }, { tenantId: tenant.id, rawBody: new URLSearchParams({ ...notify, CheckMacValue: checkMacValue(notify, T.hashKey, T.hashIv) }).toString() });
check(good.status === 200 && good.body === "1|OK", "正確 CheckMacValue 的狀態通知 → 回 1|OK", good.body);
const after = await getShipment(ctx, { site: slug, orderNo: order.order_no });
const o = (await store.getOrderById(tenant.id, order.id))!;
check(after.shipments[0]?.status === "in_transit" && o.status === "fulfilled", "出貨單 created → in_transit、訂單 paid → fulfilled", `${after.shipments[0]?.status} / ${o.status}`);

console.log(fails ? `\n${fails} 項失敗` : "\n全部通過");
process.exit(fails ? 1 : 0);
