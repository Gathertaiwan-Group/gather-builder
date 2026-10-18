#!/usr/bin/env node
// 第三批端到端：MCP 開站 → 啟用 members＋shop＋coupons＋shipping＋invoice（mock 供應商，測試租戶專用）→ 商品與折扣碼 →
// 會員註冊／登入 → 試算（套券、運費由 server 計價）→ 結帳（線下匯款、手機條碼載具）→ mark_order_paid →
// issue_invoice（mock，不會開出真實發票）→ create_shipment（手動出貨＋追蹤號）→ 會員中心看到發票號與追蹤號。
// 🔴 不碰真實發票（mock）、真實物流（手動出貨）、真實金流（線下匯款）；所有 email 用 example.com（不會實際寄出）。
// 用法：node --env-file=.env.local scripts/e2e-marketing.mjs [baseUrl] [--quick] [--newsletter-test]
//   需要 GB_PLATFORM_TOKEN（含第三批 scope 的平台 token）與 ADMIN_PASSWORD（後台輸入 mock 發票憑證用）。
//   --newsletter-test：另外寄一封測試電子報到 gathertaiwan@gmail.com（需要該環境有 RESEND_API_KEY）。
import { connect, check, done, getText } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3100";
const quick = args.includes("--quick");
const newsletterTest = args.includes("--newsletter-test");
const platformToken = process.env.GB_PLATFORM_TOKEN;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!platformToken || !adminPassword) {
  console.error("需要 GB_PLATFORM_TOKEN 與 ADMIN_PASSWORD");
  process.exit(1);
}
const ts = Date.now().toString(36);
const slug = `e2e-mkt-${ts}`;
const email = `e2e-mkt-${ts}@example.com`;
const password = `pw-${ts}-secure`;
console.log(`base=${base} slug=${slug}${quick ? " (quick)" : ""}\n`);

async function post(path, fields, cookie) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}
async function get(path, cookie) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {}, cache: "no-store" });
  return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text() };
}
const flash = (loc) => {
  const u = new URL(loc, base);
  return { ok: u.searchParams.get("ok"), err: u.searchParams.get("err") };
};

// ---- 開站 ----
const platform = await connect(base, platformToken);
const created = await platform.call("create_site", { slug, name: `E2E 行銷 ${ts}`, modules: ["sections-basic"], test: true });
check(created.token?.startsWith("gbt_"), "create_site（測試租戶 is_test）", created.__error ?? "");
check(["invoices:write", "shipping:write", "marketing:write", "newsletter:write"].every((s) => created.tokenScopes?.includes(s)), "網站 token 含第三批 scope", created.tokenScopes?.join(","));
await platform.close();
const site = await connect(base, created.token);

const tools = (await site.client.listTools()).tools.map((t) => t.name);
check(["issue_invoice", "void_invoice", "create_shipment", "create_coupon", "send_broadcast"].every((t) => tools.includes(t)), "MCP 有第三批工具", `${tools.length} 個工具`);
check(!tools.some((t) => /account|secret|credential|hash_?key|app_?key|save_/i.test(t)), "MCP 沒有任何設定／讀出 Amego、綠界、PChomePay 金鑰的工具");

await site.call("enable_module", { moduleId: "members" });
await site.call("enable_module", { moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "請匯款至 測試銀行 000-123456" }, orderPrefix: "MKT" } });
const ec = await site.call("enable_module", { moduleId: "coupons" });
check(ec.changed?.some((c) => c.id === "coupons" && c.status === "enabled"), "enable_module coupons", ec.__error ?? JSON.stringify(ec.changed));
const es = await site.call("enable_module", {
  moduleId: "shipping",
  config: { methods: [{ id: "home", type: "manual", provider: "manual", label: "宅配（店家寄送）", fee: 100, freeThreshold: 3000 }, { id: "pickup", type: "pickup", provider: "manual", label: "門市自取", fee: 0, instructions: "台北市測試路 1 號" }] },
});
check(es.changed?.some((c) => c.id === "shipping" && c.status === "enabled"), "enable_module shipping（手動宅配＋自取）", es.__error ?? JSON.stringify(es.changed));
const ei = await site.call("enable_module", { moduleId: "invoice", config: { issueMode: "manual" } });
check(ei.changed?.some((c) => c.id === "invoice" && c.status === "pending_setup"), "enable_module invoice → pending_setup（尚無憑證）", ei.__error ?? JSON.stringify(ei.changed));

// ---- 後台：mock 發票憑證（只有測試租戶能選 mock） ----
const login = await post("/api/admin/login", { password: adminPassword });
const adminCookie = login.setCookie.split(";")[0];
check(login.status === 303 && adminCookie.startsWith("gb_admin="), "後台登入");
const save = await post(`/api/admin/tenants/${slug}/invoice-account`, { provider: "mock", sellerTaxId: "53912857", appKey: "" }, adminCookie);
check(save.status === 303 && !!flash(save.location).ok, "後台輸入 mock 發票憑證（測試租戶）", flash(save.location).ok ?? flash(save.location).err);
const ver = await post(`/api/admin/tenants/${slug}/invoice-account/verify`, {}, adminCookie);
check(ver.status === 303 && /成功/.test(flash(ver.location).ok ?? ""), "後台驗證發票憑證", flash(ver.location).ok ?? flash(ver.location).err);
const inst = await site.call("get_invoice_setup_status");
check(inst.account?.status === "verified" && inst.invoiceModuleStatus === "enabled" && !JSON.stringify(inst).includes("secret_enc"), "get_invoice_setup_status：verified、模組 enabled、不含密文", inst.__error ?? "");

// ---- 商品、折扣碼、發布 ----
const prod = await site.call("create_product", { slug: "tea", name: `E2E 茶葉 ${ts}`, price: 500, trackInventory: true, stock: 10, status: "published", confirm: true });
check(prod.id && prod.status === "published", "create_product（NT$500）", prod.__error ?? "");
const cpNo = await site.call("create_coupon", { code: "OFF20", kind: "percent", value: 20 });
check(cpNo.__error?.startsWith("[invalid]"), "百分比折扣沒有上限 → 被拒", cpNo.__error?.slice(0, 60));
const cp = await site.call("create_coupon", { code: "off20", kind: "percent", value: 20, maxDiscount: 150, perUserLimit: 1 });
check(cp.code === "OFF20" && cp.usedCount === 0, "create_coupon OFF20（20%、上限 NT$150、每人 1 次）", cp.__error ?? "");
await site.call("add_section", { path: "/", type: "product_grid", props: { heading: "商品" } });
const pv = await site.call("preview_changes");
const pub = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion, note: "e2e marketing" });
check(pub.revision === 1, "publish_site", pub.__error ?? "");

// ---- 會員 ----
await post(`/s/${slug}/api/account/register`, { email, password, name: "王小明", phone: "0912000111" });
const lg = await post(`/s/${slug}/api/account/login`, { email, password });
const cookie = lg.setCookie.split(";")[0];
check(lg.status === 303 && /^gbm_/.test(cookie), "會員註冊＋登入");

// ---- 試算：套券、運費 server 計價、竄改無效 ----
const q = await fetch(`${base}/s/${slug}/api/shop/quote`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ items: [{ productId: prod.id, qty: 2, price: 1 }], shippingMethodId: "home", shippingFee: 0, couponCode: "OFF20", discount: 9999 }),
}).then((r) => r.json());
check(q.subtotal === 1000 && q.shippingFee === 100 && q.discount === 150 && q.total === 950, "quote：小計 1000＋運費 100−折扣 150（20% 封頂）＝950（竄改欄位被忽略）", JSON.stringify({ s: q.subtotal, f: q.shippingFee, d: q.discount, t: q.total }));

// ---- 結帳 ----
const co = await post(
  `/s/${slug}/api/shop/checkout`,
  {
    items: JSON.stringify([{ productId: prod.id, qty: 2, price: 1 }]),
    contactName: "王小明",
    contactEmail: email,
    contactPhone: "0912000111",
    shipSame: "on",
    shipAddress: "台北市測試路 1 號",
    paymentMethod: "offline",
    shippingMethodId: "home",
    couponCode: "OFF20",
    invoiceType: "mobile",
    invoiceCarrier: "/abc+123",
    total: "1",
  },
  cookie,
);
const orderUrl = co.location ? new URL(co.location, base) : null;
const orderNo = orderUrl ? decodeURIComponent(orderUrl.pathname.split("/").pop()) : "";
check(co.status === 303 && /^MKT-\d{8}-\d{4}$/.test(orderNo), "結帳（線下匯款、宅配、套券、手機條碼）→ 訂單頁", `${co.status} ${orderNo} ${flash(co.location || "/").err ?? ""}`);
const od = await site.call("get_order", { orderNo });
check(od.total === 950 && od.discountTotal === 150 && od.couponCode === "OFF20" && od.shippingFee === 100 && od.shippingChoice?.methodId === "home", "get_order：總計 950、折扣 150、運送方式 home", od.__error ?? JSON.stringify({ t: od.total, d: od.discountTotal }));
check(od.invoiceRequest?.type === "mobile" && od.invoiceRequest?.carrier === "/ABC+123", "訂單存了發票載具（手機條碼，轉大寫）", JSON.stringify(od.invoiceRequest));
const again = await post(
  `/s/${slug}/api/shop/checkout`,
  { items: JSON.stringify([{ productId: prod.id, qty: 1 }]), contactName: "王小明", contactEmail: email, contactPhone: "0912000111", shipSame: "on", shipAddress: "台北市測試路 1 號", paymentMethod: "offline", shippingMethodId: "pickup", couponCode: "OFF20" },
  cookie,
);
check(again.status === 303 && /使用次數上限/.test(flash(again.location).err ?? ""), "同一會員第二次用 OFF20 → 每人上限擋下", flash(again.location).err ?? again.location);
const cps = await site.call("list_coupons");
check(cps.coupons?.[0]?.usedCount === 1, "list_coupons：OFF20 已使用 1 次", `${cps.coupons?.[0]?.usedCount}`);

// ---- 收款 → 發票 → 出貨 ----
const inv0 = await site.call("issue_invoice", { orderNo, confirm: true });
check(inv0.__error?.includes("尚未付款"), "未付款訂單不能開發票", inv0.__error?.slice(0, 50));
const mp = await site.call("mark_order_paid", { orderNo, confirm: true });
check(mp.status === "paid", "mark_order_paid（線下匯款）", mp.__error ?? "");
const invNo = await site.call("issue_invoice", { orderNo });
check(invNo.__error?.startsWith("[confirm_required]"), "issue_invoice 不帶 confirm 被拒");
const inv = await site.call("issue_invoice", { orderNo, confirm: true });
check(inv.status === "issued" && /^MK\d{8}$/.test(inv.invoiceNo ?? ""), "issue_invoice（mock）→ 已開立", inv.__error ?? inv.invoiceNo);
const inv2 = await site.call("issue_invoice", { orderNo, confirm: true });
check(inv2.invoiceNo === inv.invoiceNo, "重複 issue_invoice → 回傳同一張（不重開）", inv2.invoiceNo);
const shNo = await site.call("create_shipment", { orderNo, confirm: true });
check(shNo.__error?.includes("trackingNumber"), "手動出貨沒帶追蹤號 → 被拒", shNo.__error?.slice(0, 50));
const sh = await site.call("create_shipment", { orderNo, confirm: true, trackingNumber: `E2E-TRACK-${ts}` });
check(sh.status === "in_transit" && sh.trackingNo === `E2E-TRACK-${ts}`, "create_shipment（手動出貨）", sh.__error ?? "");
const od2 = await site.call("get_order", { orderNo });
check(od2.status === "fulfilled" && od2.shippingTracking === `E2E-TRACK-${ts}` && od2.invoiceStatus === "issued", "訂單 → 已出貨、追蹤號與發票狀態同步", `${od2.status} ${od2.invoiceStatus}`);

// ---- 會員中心 ----
const acct = await get(`/s/${slug}/account`, cookie);
check(acct.status === 200 && acct.body.includes(inv.invoiceNo) && acct.body.includes(`E2E-TRACK-${ts}`), "會員中心看到發票號與追蹤號", `HTTP ${acct.status}`);
const op = await get(`/s/${slug}/orders/${encodeURIComponent(orderNo)}`, cookie);
check(op.status === 200 && op.body.includes(inv.invoiceNo) && op.body.includes("折扣"), "訂單頁顯示折扣、發票號", `HTTP ${op.status}`);

if (!quick) {
  // 作廢（同期）
  const vd = await site.call("void_invoice", { orderNo, confirm: true, reason: "e2e 測試" });
  check(vd.action === "void" && vd.status === "voided", "void_invoice（同期 → 作廢）", vd.__error ?? vd.action);
  const ls = await site.call("list_shipments");
  check(ls.total === 1 && ls.shipments[0].orderNo === orderNo, "list_shipments", `${ls.total}`);
  const page = await getText(`${base}/s/${slug}/checkout`);
  check(page.status === 200, "結帳頁可開（含運送方式／折扣碼／發票欄位）", `HTTP ${page.status}`);
}

if (newsletterTest) {
  await site.call("enable_module", { moduleId: "newsletter" });
  const b = await site.call("create_broadcast", { subject: `【E2E】gather-builder 電子報測試 ${ts}`, bodyMd: "這是 gather-builder **電子報模組** 的端到端測試信（只寄到 gathertaiwan@gmail.com）。" });
  check(!!b.id, "create_broadcast", b.__error ?? "");
  const bad = await site.call("send_test_broadcast", { broadcastId: b.id, to: "someone@gmail.com" });
  check(bad.__error?.startsWith("[forbidden]"), "測試租戶的測試信不能寄到白名單以外", bad.__error?.slice(0, 50));
  const t = await site.call("send_test_broadcast", { broadcastId: b.id, to: "gathertaiwan@gmail.com" });
  check(t.sent === true && !!t.providerMessageId, "send_test_broadcast → Resend 接受（回傳訊息 id）", t.__error ?? `id=${t.providerMessageId ? `${String(t.providerMessageId).slice(0, 8)}…` : "-"}`);
}

await site.close();
console.log(`\nslug=${slug} order=${orderNo} invoice=${inv.invoiceNo ?? "-"}`);
done();
