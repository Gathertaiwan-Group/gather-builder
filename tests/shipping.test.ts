/**
 * shipping 模組：CheckMacValue（官方範例向量）、竄改被拒、電子地圖 callback 綁不到別人的結帳、運費 server 計價、
 * 物流狀態通知、建立出貨單。🔴 全部用假 fetch，不呼叫綠界（stage 實測另見 scripts/e2e-ecpay-stage.mjs）。
 * 綠界測試特店（2000933／XBERn1YOvpM9nfZc／h1ONHk4P4yqbl5LK）為官方公開測試值：https://developers.ecpay.com.tw/?p=7398
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { placeOrder } from "@/lib/services/shop";
import { fulfillOrder, markOrderPaid } from "@/lib/services/orders";
import {
  availableShippingMethods,
  createShipment,
  handleCvsMapCallback,
  handleLogisticsNotify,
  publishedShippingSettings,
  saveShippingAccount,
  selectionForBrowser,
  startCvsSelection,
} from "@/lib/services/shipping";
import { ECPAY_STAGE_TEST_MERCHANTS, checkMacValue, dotnetUrlEncode, isValidEcpayName, mapLogisticsStatus, parseEcpayResponse, verifyCheckMacValue } from "@/lib/shipping/ecpay";
import { handleQuote } from "@/lib/shop-routes";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "http://test.local";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 4).toString("base64");
});

const T = ECPAY_STAGE_TEST_MERCHANTS.C2C;
const contact = { name: "王小明", email: "buyer@example.com", phone: "0912345678" };
const shipping = { name: "王小明", phone: "0912345678", address: "台中市西屯區測試路 1 號" };

const METHODS = [
  { id: "seven", type: "cvs", provider: "ecpay", subType: "UNIMARTC2C", label: "7-11 取貨", fee: 60, freeThreshold: 999 },
  { id: "home", type: "manual", provider: "manual", label: "宅配（店家寄送）", fee: 100 },
  { id: "pickup", type: "pickup", provider: "manual", label: "門市自取", fee: 0, instructions: "台中市測試路 1 號" },
];

async function shipShop(store: Store, slug: string, opts: { stage?: boolean } = {}) {
  const shop = await makeShop(store, slug);
  const ctx = ctxFor(store);
  await enableModule(ctx, { site: slug, moduleId: "shipping", config: { methods: METHODS, sender: { name: "林店長", cellPhone: "0911222333" } } });
  await saveShippingAccount(ctx, { site: slug, merchantId: T.merchantId, hashKey: T.hashKey, hashIv: T.hashIv, stage: opts.stage ?? false, kind: "C2C" });
  await publishSite(ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  return { ...shop, ctx, tenant };
}

/** 模擬綠界電子地圖：從 startCvsSelection 的表單取 MerchantTradeNo，回傳門市 */
async function pickStore(store: Store, tenantId: string, form: Record<string, string>, storeId = "131386") {
  return handleCvsMapCallback(store, tenantId, { MerchantID: form.MerchantID!, MerchantTradeNo: form.MerchantTradeNo!, LogisticsSubType: form.LogisticsSubType!, CVSStoreID: storeId, CVSStoreName: "測試門市", CVSAddress: "台北市測試路", CVSOutSide: "0" });
}

describe("CheckMacValue（官方演算法）", () => {
  const sample = {
    MerchantID: "2000933",
    MerchantTradeNo: "A20130312153023",
    MerchantTradeDate: "2013/03/12 15:30:23",
    LogisticsType: "CVS",
    LogisticsSubType: "FAMIC2C",
    GoodsAmount: "1000",
    IsCollection: "N",
    ServerReplyURL: "https://www.ecpay.com.tw/ServerReplyURL",
    SenderName: "寄件者姓名",
    ReceiverName: "收件者姓名",
    ReceiverStoreID: "001779",
  };
  it("官方文件範例向量 → 692FD6E2CDB539CCDB7206C76DC239AD（https://developers.ecpay.com.tw/?p=7424）", () => {
    expect(checkMacValue(sample, "XBERn1YOvpM9nfZc", "h1ONHk4P4yqbl5LK")).toBe("692FD6E2CDB539CCDB7206C76DC239AD");
  });
  it("竄改任一欄位、錯金鑰、格式錯 → 驗證失敗；大小寫不影響", () => {
    const mac = checkMacValue(sample, T.hashKey, T.hashIv);
    expect(verifyCheckMacValue({ ...sample, CheckMacValue: mac }, T.hashKey, T.hashIv)).toBe(true);
    expect(verifyCheckMacValue({ ...sample, CheckMacValue: mac.toLowerCase() }, T.hashKey, T.hashIv)).toBe(true);
    expect(verifyCheckMacValue({ ...sample, GoodsAmount: "1", CheckMacValue: mac }, T.hashKey, T.hashIv)).toBe(false);
    expect(verifyCheckMacValue({ ...sample, CheckMacValue: mac }, "wrongkey12345678", T.hashIv)).toBe(false);
    expect(verifyCheckMacValue({ ...sample, CheckMacValue: "zz" }, T.hashKey, T.hashIv)).toBe(false);
    expect(verifyCheckMacValue({ ...sample }, T.hashKey, T.hashIv)).toBe(false);
  });
  it(".NET URL encode：空白→+、~ 與 ' 要編碼、!*()-_. 不編碼", () => {
    expect(dotnetUrlEncode("a b~c'd!*()-_.")).toBe("a+b%7Ec%27d!*()-_.");
  });
});

describe("綠界回應與規則", () => {
  it("Create 回應 pipe 格式：只解析尾段；C2C 成功 RtnCode 300；失敗 0|訊息", () => {
    const ok = parseEcpayResponse("1|MerchantID=2000933&MerchantTradeNo=S1&RtnCode=300&RtnMsg=訂單處理中&AllPayLogisticsID=1234567&CVSPaymentNo=C001&CVSValidationNo=9");
    expect(ok.ok).toBe(true);
    expect(ok.fields.AllPayLogisticsID).toBe("1234567");
    expect(ok.fields.RtnCode).toBe("300");
    const bad = parseEcpayResponse("0|收件人姓名格式錯誤");
    expect(bad.ok).toBe(false);
    expect(bad.message).toBe("收件人姓名格式錯誤");
  });
  it("收件人姓名：中文 2–5 字或英文 4–10 字，不可混合／數字／空白", () => {
    for (const ok of ["王小明", "歐陽·娜娜", "John", "Johnsmith"]) expect(isValidEcpayName(ok)).toBe(true);
    for (const bad of ["王", "王小明明明明", "王小明2", "John Smith", "Jo", "王John", "王小明!"]) expect(isValidEcpayName(bad)).toBe(false);
  });
  it("物流狀態代碼對應", () => {
    expect(mapLogisticsStatus("300")).toBe("created");
    expect(mapLogisticsStatus("2030")).toBe("in_transit");
    expect(mapLogisticsStatus("2073")).toBe("arrived");
    expect(mapLogisticsStatus("3022")).toBe("delivered");
    expect(mapLogisticsStatus("2074")).toBe("returned");
    expect(mapLogisticsStatus("9999")).toBeNull();
  });
});

describe("電子地圖選店：綁不到別人的結帳", () => {
  it("callback 只寫回自己那筆；別的瀏覽器（binding 不同）拿不走；來源 MerchantID、子類型、逾用都會擋", async () => {
    const store = newStore();
    const s = await shipShop(store, "cvs-bind");
    const a = await startCvsSelection(store, s.tenant, { methodId: "seven", baseUrl: "http://test.local", mobile: false });
    const b = await startCvsSelection(store, s.tenant, { methodId: "seven", baseUrl: "http://test.local", mobile: false });
    expect(a.form.action).toBe("https://logistics.ecpay.com.tw/Express/map");
    expect(a.form.fields.ServerReplyURL).toBe(`http://test.local/api/ship/ecpay/map/${s.tenant.id}`);
    expect(a.form.fields.MerchantTradeNo).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(a.form.fields.MerchantTradeNo).not.toBe(b.form.fields.MerchantTradeNo);

    // 來源不對（MerchantID 不是這個租戶的）
    expect((await handleCvsMapCallback(store, s.tenant.id, { ...a.form.fields, MerchantID: "9999999", CVSStoreID: "131386" })).ok).toBe(false);
    // 子類型被改
    expect((await handleCvsMapCallback(store, s.tenant.id, { ...a.form.fields, LogisticsSubType: "FAMIC2C", CVSStoreID: "131386" })).ok).toBe(false);
    // 別的租戶路徑
    const other = await shipShop(store, "cvs-other");
    expect((await pickStore(store, other.tenant.id, a.form.fields)).ok).toBe(false);
    // 正常
    const ra = await pickStore(store, s.tenant.id, a.form.fields);
    expect(ra.ok).toBe(true);
    // B 的瀏覽器拿 A 的 selectionId → 看不到也用不了
    expect(await selectionForBrowser(store, s.tenant, ra.selectionId!, b.binding)).toBeNull();
    expect(await selectionForBrowser(store, s.tenant, ra.selectionId!, a.binding)).toMatchObject({ methodId: "seven", store: { id: "131386" } });
    await expect(
      placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: b.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } }),
    ).rejects.toThrow(/門市已逾時或無效/);
    // 其他租戶拿這個 id 也不行
    await expect(
      placeOrder({ store, baseUrl: "http://t" }, { tenant: other.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: other.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } }),
    ).rejects.toThrow(/門市已逾時或無效/);
    // A 本人可以，而且只能用一次
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } });
    expect(order.shipping_choice).toMatchObject({ methodId: "seven", subType: "UNIMARTC2C", store: { id: "131386", name: "測試門市" } });
    await expect(
      placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } }),
    ).rejects.toThrow(/門市已逾時或無效/);
    // 用過的暫存不能再被 callback 改門市
    expect((await pickStore(store, s.tenant.id, a.form.fields, "999999")).ok).toBe(false);
  });

  it("下單失敗會歸還選店暫存（可以重新下單）", async () => {
    const store = newStore();
    const s = await shipShop(store, "cvs-release");
    const a = await startCvsSelection(store, s.tenant, { methodId: "seven", baseUrl: "http://test.local", mobile: true });
    expect(a.form.fields.Device).toBe("1");
    const ra = await pickStore(store, s.tenant.id, a.form.fields);
    await expect(
      placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "pchomepay", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } }),
    ).rejects.toThrow(/無法使用線上付款/); // 消耗選店之後才失敗
    const ok = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } });
    expect(ok.order.shipping_choice?.store?.id).toBe("131386");
  });
});

describe("運費由 server 計價", () => {
  it("依運送方式與滿額免運計算；前端送的運費無效；必須選方式", async () => {
    const store = newStore();
    const s = await shipShop(store, "ship-fee");
    const r1 = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "home" } });
    expect(r1.order.shipping_fee).toBe(100);
    expect(r1.order.total).toBe(450);
    const r2 = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "pickup" } });
    expect(r2.order.shipping_fee).toBe(0);
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline" } })).rejects.toThrow(/請選擇運送方式/);
    await expect(placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "nope" } })).rejects.toThrow(/請選擇運送方式/);
    // quote：竄改的 shippingFee 欄位被忽略；超商滿 999 免運
    const q = await handleQuote(new Request("http://test.local/q", { method: "POST", body: JSON.stringify({ items: [{ productId: s.mug.id, qty: 3 }], shippingMethodId: "seven", shippingFee: 0, total: 1 }) }), "ship-fee", store);
    const j = (await q.json()) as { subtotal: number; shippingFee: number; total: number };
    expect(j).toMatchObject({ subtotal: 1050, shippingFee: 0, total: 1050 });
    const q2 = await handleQuote(new Request("http://test.local/q", { method: "POST", body: JSON.stringify({ items: [{ productId: s.mug.id, qty: 1 }], shippingMethodId: "seven", shippingFee: 0 }) }), "ship-fee", store);
    expect(((await q2.json()) as { shippingFee: number }).shippingFee).toBe(60);
  });

  it("超商取貨的收件人姓名／手機照綠界規則先擋；綠界測試環境帳號只在預覽可用", async () => {
    const store = newStore();
    const s = await shipShop(store, "ship-rule");
    const a = await startCvsSelection(store, s.tenant, { methodId: "seven", baseUrl: "http://t", mobile: false });
    const ra = await pickStore(store, s.tenant.id, a.form.fields);
    await expect(
      placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping: { ...shipping, name: "Wang 小明" }, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } }),
    ).rejects.toThrow(/收件人姓名/);
    const stage = await shipShop(store, "ship-stage", { stage: true });
    const settings = (await publishedShippingSettings(store, stage.tenant))!;
    expect((await availableShippingMethods(store, stage.tenant, settings)).map((m) => m.id)).toEqual(["home", "pickup"]);
    expect((await availableShippingMethods(store, stage.tenant, settings, { allowStage: true })).map((m) => m.id)).toEqual(["seven", "home", "pickup"]);
  });
});

describe("出貨單與物流狀態通知", () => {
  async function paidCvsOrder(store: Store, slug: string) {
    const s = await shipShop(store, slug);
    const a = await startCvsSelection(store, s.tenant, { methodId: "seven", baseUrl: "http://t", mobile: false });
    const ra = await pickStore(store, s.tenant.id, a.form.fields);
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, cvsBinding: a.binding, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "seven", cvsSelectionId: ra.selectionId } });
    await markOrderPaid(s.ctx, { site: slug, orderNo: order.order_no, confirm: true });
    return { ...s, order };
  }

  /** 假綠界：回 C2C 成功（RtnCode 300）並帶正確 CheckMacValue */
  const fakeEcpay = (logisticsId = "2051234") => async (_url: string, init: RequestInit) => {
    const sent = Object.fromEntries(new URLSearchParams(String(init.body)));
    expect(verifyCheckMacValue(sent, T.hashKey, T.hashIv)).toBe(true);
    const resp: Record<string, string> = { MerchantID: T.merchantId, MerchantTradeNo: sent.MerchantTradeNo!, RtnCode: "300", RtnMsg: "訂單處理中", AllPayLogisticsID: logisticsId, LogisticsType: "CVS", LogisticsSubType: sent.LogisticsSubType!, GoodsAmount: sent.GoodsAmount!, CVSPaymentNo: "C123456", CVSValidationNo: "7788" };
    resp.CheckMacValue = checkMacValue(resp, T.hashKey, T.hashIv);
    return new Response(`1|${new URLSearchParams(resp).toString()}`, { status: 200 });
  };

  it("綠界：建單（需 confirm）→ 狀態通知（正確 CheckMacValue）→ 訂單轉已出貨；竄改的通知被拒", async () => {
    const store = newStore();
    const s = await paidCvsOrder(store, "ship-notify");
    await expect(createShipment(s.ctx, { site: "ship-notify", orderNo: s.order.order_no }, fakeEcpay())).rejects.toMatchObject({ code: "confirm_required" });
    const sh = await createShipment(s.ctx, { site: "ship-notify", orderNo: s.order.order_no, confirm: true }, fakeEcpay());
    expect(sh).toMatchObject({ provider: "ecpay", status: "created", logisticsId: "2051234", trackingNo: "C123456" });
    await expect(createShipment(s.ctx, { site: "ship-notify", orderNo: s.order.order_no, confirm: true }, fakeEcpay())).rejects.toMatchObject({ code: "conflict" });
    await expect(fulfillOrder(s.ctx, { site: "ship-notify", orderNo: s.order.order_no, confirm: true })).rejects.toThrow(/以物流通知為準/);
    const row = (await store.getActiveShipmentByOrder(s.tenant.id, s.order.id))!;
    const notify: Record<string, string> = { MerchantID: T.merchantId, MerchantTradeNo: row.merchant_trade_no!, RtnCode: "2030", RtnMsg: "商品已送至物流中心", AllPayLogisticsID: "2051234", LogisticsType: "CVS", LogisticsSubType: "UNIMARTC2C", GoodsAmount: "350", UpdateStatusDate: "2026/10/19 10:00:00", ReceiverName: "王小明", ReceiverPhone: "", ReceiverCellPhone: "0912345678", ReceiverEmail: "buyer@example.com", ReceiverAddress: "", CVSPaymentNo: "C123456", CVSValidationNo: "7788", BookingNote: "" };
    const good = { ...notify, CheckMacValue: checkMacValue(notify, T.hashKey, T.hashIv) };
    const deps = { store, baseUrl: "http://t" };
    // 竄改：改狀態碼但沿用舊 CheckMacValue
    const tampered = new URLSearchParams({ ...good, RtnCode: "3022" }).toString();
    expect(await handleLogisticsNotify(deps, { tenantId: s.tenant.id, rawBody: tampered })).toMatchObject({ status: 400, body: "0|CheckMacValueError" });
    expect((await store.getOrderById(s.tenant.id, s.order.id))!.status).toBe("paid");
    // 正確 → 1|OK、出貨單 in_transit、訂單 fulfilled
    expect(await handleLogisticsNotify(deps, { tenantId: s.tenant.id, rawBody: new URLSearchParams(good).toString() })).toMatchObject({ status: 200, body: "1|OK" });
    expect((await store.getActiveShipmentByOrder(s.tenant.id, s.order.id))!.status).toBe("in_transit");
    const o = (await store.getOrderById(s.tenant.id, s.order.id))!;
    expect(o.status).toBe("fulfilled");
    expect(o.shipping_tracking).toBe("C123456");
    // 換了 AllPayLogisticsID（同一 MerchantTradeNo）→ 拒絕
    const other = { ...notify, AllPayLogisticsID: "999" };
    expect(await handleLogisticsNotify(deps, { tenantId: s.tenant.id, rawBody: new URLSearchParams({ ...other, CheckMacValue: checkMacValue(other, T.hashKey, T.hashIv) }).toString() })).toMatchObject({ status: 400 });
    // 打到別的租戶路徑（用別人的金鑰驗不過）
    const t2 = await shipShop(store, "ship-notify-2");
    await saveShippingAccount(t2.ctx, { site: "ship-notify-2", merchantId: "2000132", hashKey: "5294y06JbISpM5x9", hashIv: "v77hoKGq4kWxNNIS", stage: true, kind: "B2C" });
    expect((await handleLogisticsNotify(deps, { tenantId: t2.tenant.id, rawBody: new URLSearchParams(good).toString() })).status).toBe(400);
    // 狀態不倒退：送達後再收到「已到物流中心」不會退回
    const done = { ...notify, RtnCode: "2067", RtnMsg: "取件" };
    await handleLogisticsNotify(deps, { tenantId: s.tenant.id, rawBody: new URLSearchParams({ ...done, CheckMacValue: checkMacValue(done, T.hashKey, T.hashIv) }).toString() });
    await handleLogisticsNotify(deps, { tenantId: s.tenant.id, rawBody: new URLSearchParams(good).toString() });
    expect((await store.getActiveShipmentByOrder(s.tenant.id, s.order.id))!.status).toBe("delivered");
  });

  it("綠界回應的 CheckMacValue 不對 → 不採信、出貨單標失敗、可重建", async () => {
    const store = newStore();
    const s = await paidCvsOrder(store, "ship-badresp");
    const bad = async () => new Response("1|MerchantID=2000933&MerchantTradeNo=x&RtnCode=300&AllPayLogisticsID=1&CheckMacValue=00000000000000000000000000000000", { status: 200 });
    await expect(createShipment(s.ctx, { site: "ship-badresp", orderNo: s.order.order_no, confirm: true }, bad)).rejects.toThrow(/CheckMacValue/);
    expect(await store.getActiveShipmentByOrder(s.tenant.id, s.order.id)).toBeNull();
    await expect(createShipment(s.ctx, { site: "ship-badresp", orderNo: s.order.order_no, confirm: true }, fakeEcpay("777"))).resolves.toMatchObject({ logisticsId: "777" });
  });

  it("手動出貨：帶追蹤號 → 訂單已出貨，會員中心看得到；未付款不能出貨", async () => {
    const store = newStore();
    const s = await shipShop(store, "ship-manual");
    const { order } = await placeOrder({ store, baseUrl: "http://t" }, { tenant: s.tenant, member: null, data: { items: [{ productId: s.mug.id, qty: 1 }], contact, shipping, paymentMethod: "offline", shippingMethodId: "home" } });
    await expect(createShipment(s.ctx, { site: "ship-manual", orderNo: order.order_no, confirm: true, trackingNumber: "T1" })).rejects.toMatchObject({ code: "conflict" });
    await markOrderPaid(s.ctx, { site: "ship-manual", orderNo: order.order_no, confirm: true });
    await expect(createShipment(s.ctx, { site: "ship-manual", orderNo: order.order_no, confirm: true })).rejects.toThrow(/trackingNumber/);
    const r = await createShipment(s.ctx, { site: "ship-manual", orderNo: order.order_no, confirm: true, trackingNumber: "HCT-0001" });
    expect(r).toMatchObject({ provider: "manual", status: "in_transit", trackingNo: "HCT-0001" });
    const o = (await store.getOrderById(s.tenant.id, order.id))!;
    expect(o.status).toBe("fulfilled");
    expect(o.shipping_tracking).toBe("HCT-0001");
  });

  it("憑證只能後台輸入", async () => {
    const store = newStore();
    const s = await shipShop(store, "ship-cred");
    const tok = ctxFor(store, { kind: "token", label: "t", tenantId: s.tenant.id, scopes: ["shipping:write", "orders:read"] });
    await expect(saveShippingAccount(tok, { site: "ship-cred", merchantId: "1", hashKey: "aaaaaaaa", hashIv: "bbbbbbbb", stage: true, kind: "C2C" })).rejects.toMatchObject({ code: "forbidden" });
    expect(JSON.stringify(await store.getShippingAccount(s.tenant.id))).not.toContain(T.hashKey);
  });
});
