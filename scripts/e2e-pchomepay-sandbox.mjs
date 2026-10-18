#!/usr/bin/env node
// PChomePay「sandbox」端到端（只在本機跑）：後台輸入測試金鑰 → 驗證 → 結帳選線上付款 → 303 到 sandbox-secure 付款頁。
// 🔴 不跟隨付款頁、不刷卡；只接受 sandbox。正式金鑰打 sandbox 本來就會 401。
// 用法（金鑰只經環境變數傳入，不寫進任何檔案）：
//   PCHOMEPAY_SANDBOX_APP_ID=… PCHOMEPAY_SANDBOX_SECRET=… node --env-file=.env.local scripts/e2e-pchomepay-sandbox.mjs http://localhost:3100
import { connect, check, done } from "./mcp-client.mjs";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  console.error("只允許在本機（localhost）跑 sandbox 測試");
  process.exit(1);
}
const appId = process.env.PCHOMEPAY_SANDBOX_APP_ID;
const secret = process.env.PCHOMEPAY_SANDBOX_SECRET;
const platformToken = process.env.GB_PLATFORM_TOKEN;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!appId || !secret || !platformToken || !adminPassword) {
  console.error("需要 PCHOMEPAY_SANDBOX_APP_ID、PCHOMEPAY_SANDBOX_SECRET、GB_PLATFORM_TOKEN、ADMIN_PASSWORD");
  process.exit(1);
}

const ts = Date.now().toString(36);
const slug = `e2e-pc-${ts}`;
console.log(`base=${base} slug=${slug}\n`);

async function post(path, fields, cookie) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}
const flash = (loc) => {
  const u = new URL(loc, base);
  return { ok: u.searchParams.get("ok"), err: u.searchParams.get("err") };
};

const platform = await connect(base, platformToken);
const created = await platform.call("create_site", { slug, name: `PChomePay 測試 ${ts}`, modules: ["sections-basic", "shop"], test: true });
check(!!created.token, "create_site（測試租戶）", created.__error ?? "");
await platform.close();
const site = await connect(base, created.token);
await site.call("configure_module", { moduleId: "shop", config: { shippingFee: 0, orderPrefix: "PC" } });
const prod = await site.call("create_product", { slug: "sandbox-item", name: "Sandbox 測試商品", price: 120, status: "published", confirm: true });
const pv = await site.call("preview_changes");
await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion });

const before = await site.call("get_payment_setup_status");
check(before.shopModuleStatus === "pending_setup" && before.pchomepay?.configured === false, "設定前：shop pending_setup、無憑證");

// 後台登入 → 輸入 sandbox 憑證 → 驗證
const login = await post("/api/admin/login", { password: adminPassword });
const adminCookie = login.setCookie.split(";")[0];
check(login.status === 303 && adminCookie.startsWith("gb_admin="), "後台登入");
const save = await post(`/api/admin/tenants/${slug}/payment-account`, { appId, secret, sandbox: "on" }, adminCookie);
check(save.status === 303 && !!flash(save.location).ok, "後台輸入 sandbox 憑證（加密儲存）", flash(save.location).ok ?? flash(save.location).err);
const verify = await post(`/api/admin/tenants/${slug}/payment-account/verify`, {}, adminCookie);
const vf = flash(verify.location);
check(verify.status === 303 && /驗證成功/.test(vf.ok ?? ""), "後台「驗證」→ 用該組憑證打 sandbox /v1/token 成功", vf.ok ?? vf.err);

const after = await site.call("get_payment_setup_status");
check(after.pchomepay?.status === "verified" && after.pchomepay?.sandbox === true && after.shopModuleStatus === "enabled", "驗證後：verified／sandbox／shop enabled", JSON.stringify({ s: after.shopModuleStatus, p: after.pchomepay?.status, sb: after.pchomepay?.sandbox }));
check(!JSON.stringify(after).includes(secret) && !JSON.stringify(after).includes(appId), "MCP 狀態查詢不含 secret 與完整 APP ID");

// 結帳選 PChomePay → 303 到 sandbox-secure（不跟隨、不刷卡）
const co = await post(`/s/${slug}/api/shop/checkout`, {
  items: JSON.stringify([{ productId: prod.id, qty: 1 }]),
  contactName: "Sandbox 測試",
  contactEmail: `pc-${ts}@example.com`,
  contactPhone: "0912000222",
  shipSame: "on",
  shipAddress: "測試地址",
  paymentMethod: "pchomepay",
});
let host = "";
try {
  host = new URL(co.location).host;
} catch {
  /* 下方 check 會失敗 */
}
check(co.status === 303 && host === "sandbox-secure.pchomepay.com.tw", "結帳 PChomePay → 303，Location 指向 sandbox-secure.pchomepay.com.tw", `${co.status} host=${host || co.location.slice(0, 80)}`);

const orders = await site.call("list_orders");
const order = orders.orders?.[0];
const detail = order ? await site.call("get_order", { orderNo: order.orderNo }) : {};
const p = detail.payments?.[0];
check(!!p && /^GB[A-Z0-9]+$/.test(p.gatewayOrderNo) && p.sandbox === true && p.status === "pending" && p.amount === 120, "builder_payments 寫入 gateway_order_no（sandbox、pending、NT$120）", p ? `${p.gatewayOrderNo} ${p.status}` : detail.__error);
check(detail.status === "pending_payment", "訂單維持待付款（return_url 不改狀態，付款只認 notify 回查）");

// 收尾：取消這張 sandbox 訂單（回補庫存）
const c = await site.call("cancel_order", { orderNo: order?.orderNo, confirm: true, reason: "sandbox e2e cleanup" });
check(c.status === "cancelled", "取消測試訂單", c.__error ?? "");
await site.close();
console.log(`\nslug=${slug} gateway=${p?.gatewayOrderNo ?? "-"}`);
done();
