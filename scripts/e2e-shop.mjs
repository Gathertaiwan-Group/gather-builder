#!/usr/bin/env node
// 端到端：MCP 開站 → 啟用 members＋shop → 建商品（上架需 confirm）→ 發布 → HTTP 會員註冊/登入 →
// 購物車計價（竄改價格無效）→ 結帳（線下匯款）→ mark_order_paid → fulfill_order → 會員中心看得到訂單。
// 用法：node --env-file=.env.local scripts/e2e-shop.mjs [baseUrl] [--quick]
//   需要 GB_PLATFORM_TOKEN（含 commerce/orders/members scope 的平台 token）。
//   --quick：正式站精簡版（開站→會員註冊→商品→線下匯款下單→mark_order_paid）。
import { connect, check, done, getText } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3100";
const quick = args.includes("--quick");
const platformToken = process.env.GB_PLATFORM_TOKEN;
if (!platformToken) {
  console.error("缺少 GB_PLATFORM_TOKEN");
  process.exit(1);
}

const ts = Date.now().toString(36);
const slug = `e2e-shop-${ts}`;
const email = `e2e-${ts}@example.com`;
const password = `pw-${ts}-secure`;
const PRODUCT = `E2E 測試商品 ${ts}`;
console.log(`base=${base} slug=${slug}${quick ? " (quick)" : ""}\n`);

/** 不自動跟隨 redirect 的表單 POST */
async function post(path, fields, cookie) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "", body: await res.text() };
}
async function get(path, cookie) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {}, cache: "no-store" });
  return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text() };
}

const platform = await connect(base, platformToken);
const created = await platform.call("create_site", { slug, name: `E2E 商店 ${ts}`, modules: ["sections-basic"], test: true });
check(created.slug === slug && created.token?.startsWith("gbt_"), "create_site（測試租戶 is_test）", created.__error ?? "");
check(["members:read", "commerce:write", "orders:write"].every((s) => created.tokenScopes?.includes(s)), "網站 token 含 members／commerce／orders scope", created.tokenScopes?.join(","));
await platform.close();

const site = await connect(base, created.token);
const em = await site.call("enable_module", { moduleId: "members" });
check(em.changed?.some((c) => c.id === "members"), "enable_module members", em.__error ?? "");
const es = await site.call("enable_module", { moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "請匯款至 測試銀行 000-123456" }, shippingFee: 60, freeShippingThreshold: 5000, orderPrefix: "E2E" } });
check(es.changed?.some((c) => c.id === "shop" && c.status === "pending_setup"), "enable_module shop → pending_setup（尚無已驗證金流憑證）", es.__error ?? JSON.stringify(es.changed));

const setup = await site.call("get_payment_setup_status");
check(setup.pchomepay?.configured === false && setup.offlineTransfer?.enabled === false, "get_payment_setup_status：未設定憑證（線下匯款設定在草稿，尚未發布）", setup.__error ?? JSON.stringify(setup.pchomepay));

const noConfirm = await site.call("create_product", { slug: "mug", name: PRODUCT, price: 380, trackInventory: true, stock: 3, status: "published" });
check(noConfirm.__error?.startsWith("[confirm_required]"), "create_product published 不帶 confirm 被拒", noConfirm.__error?.slice(0, 40));
const prod = await site.call("create_product", { slug: "mug", name: PRODUCT, price: 380, trackInventory: true, stock: 3, status: "published", confirm: true, descriptionMd: "**E2E** 測試用" });
check(prod.status === "published" && prod.id, "create_product（published, confirm:true）", prod.__error ?? prod.id);

await site.call("add_section", { path: "/", type: "product_grid", props: { heading: "精選商品", limit: 6 } });
if (!quick) await site.call("add_section", { path: "/", type: "account_cta", props: { heading: "加入會員" } });
const pv = await site.call("preview_changes");
const pub = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion, note: "e2e shop" });
check(pub.revision === 1, "publish_site 第 1 版", pub.__error ?? "");

const shopPage = await getText(`${base}/s/${slug}/shop`);
check(shopPage.status === 200 && shopPage.body.includes(PRODUCT), "前台 /shop 看到商品", `HTTP ${shopPage.status}`);
if (!quick) {
  const home = await getText(`${base}/s/${slug}`);
  check(home.body.includes(PRODUCT) && home.body.includes("加入會員"), "首頁 product_grid＋account_cta");
  const pd = await getText(`${base}/s/${slug}/shop/mug`);
  check(pd.status === 200 && pd.body.includes("加入購物車"), "商品頁 /shop/mug", `HTTP ${pd.status}`);
}

// ---- 會員註冊／登入（HTTP） ----
const reg = await post(`/s/${slug}/api/account/register`, { email, password, name: "E2E 會員", phone: "0912000111" });
check(reg.status === 303 && reg.location.includes("/account/login") && decodeURIComponent(reg.location).includes("註冊完成"), "會員註冊 → 303 回登入頁", `${reg.status}`);
const bad = await post(`/s/${slug}/api/account/login`, { email, password: "wrong-password" });
const ghost = await post(`/s/${slug}/api/account/login`, { email: `ghost-${ts}@example.com`, password });
const msg = (loc) => new URL(loc, base).searchParams.get("err");
check(msg(bad.location) === msg(ghost.location) && !!msg(bad.location), "密碼錯與帳號不存在的錯誤訊息一致", msg(bad.location));
const login = await post(`/s/${slug}/api/account/login`, { email, password });
const cookie = login.setCookie.split(";")[0];
check(login.status === 303 && /^gbm_[0-9a-f]{12}=/.test(cookie) && new RegExp(`Path=/s/${slug}(;|$)`, "i").test(login.setCookie) && /HttpOnly/i.test(login.setCookie), "登入 → HttpOnly cookie，path 限定 /s/<slug>", login.setCookie.replace(/=[^;]+/, "=…").slice(0, 120));
const acct = await get(`/s/${slug}/account`, cookie);
check(acct.status === 200 && acct.body.includes(email), "會員中心（帶 cookie）", `HTTP ${acct.status}`);

// ---- 購物車計價：前端送的價格一律無效 ----
const quote = await fetch(`${base}/s/${slug}/api/shop/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: prod.id, qty: 2, price: 1, unitPrice: 1 }] }) }).then((r) => r.json());
check(quote.subtotal === 760 && quote.shippingFee === 60 && quote.total === 820, "quote 依 DB 重新計價（竄改的 price 被忽略）", `subtotal=${quote.subtotal} total=${quote.total}`);

// ---- 結帳（線下匯款，會員） ----
const co = await post(
  `/s/${slug}/api/shop/checkout`,
  {
    items: JSON.stringify([{ productId: prod.id, qty: 2, price: 1 }]),
    total: "1",
    contactName: "E2E 會員",
    contactEmail: email,
    contactPhone: "0912000111",
    shipSame: "on",
    shipAddress: "台北市測試路 1 號",
    paymentMethod: "offline",
  },
  cookie,
);
const orderUrl = co.location ? new URL(co.location, base) : null;
const orderNo = orderUrl ? decodeURIComponent(orderUrl.pathname.split("/").pop()) : "";
check(co.status === 303 && /^E2E-\d{8}-\d{4}$/.test(orderNo), "結帳（線下匯款）→ 303 到訂單頁", `${co.status} ${orderNo}`);
const op = await get(`${orderUrl?.pathname}${orderUrl?.search}`);
check(op.status === 200 && op.body.includes("待付款") && op.body.includes("NT$820"), "訂單頁（存取金鑰）顯示待付款、總計 NT$820", `HTTP ${op.status}`);
const noKey = await get(orderUrl?.pathname ?? "/");
check(noKey.status === 404, "沒有金鑰也沒登入 → 訂單頁 404", `HTTP ${noKey.status}`);

const got = await site.call("get_order", { orderNo });
check(got.total === 820 && got.status === "pending_payment" && got.memberId, "get_order：總計 820、掛會員", got.__error ?? `${got.status}`);
const stock = await site.call("list_products");
check(stock.products?.[0]?.stock === 1, "下單扣庫存 3 → 1", `stock=${stock.products?.[0]?.stock}`);

const mpNo = await site.call("mark_order_paid", { orderNo });
check(mpNo.__error?.startsWith("[confirm_required]"), "mark_order_paid 不帶 confirm 被拒");
const mp = await site.call("mark_order_paid", { orderNo, confirm: true });
check(mp.status === "paid", "mark_order_paid（confirm）→ paid", mp.__error ?? "");

if (!quick) {
  const ff = await site.call("fulfill_order", { orderNo, confirm: true, trackingNumber: "E2E-TRACK-1" });
  check(ff.status === "fulfilled", "fulfill_order（confirm）→ fulfilled", ff.__error ?? "");
  const again = await site.call("mark_order_paid", { orderNo, confirm: true });
  check(again.__error?.startsWith("[conflict]"), "已出貨訂單再標記收款 → 狀態機拒絕", again.__error?.slice(0, 50));
  const acct2 = await get(`/s/${slug}/account`, cookie);
  check(acct2.body.includes(orderNo) && acct2.body.includes("已出貨"), "會員中心「我的訂單」看得到該訂單（已出貨）");
  const memberOrder = await get(`/s/${slug}/orders/${encodeURIComponent(orderNo)}`, cookie);
  check(memberOrder.status === 200 && memberOrder.body.includes("已出貨"), "會員本人不帶金鑰也能看自己的訂單");

  const members = await site.call("list_members");
  check(members.total === 1 && members.members[0].email === email && !JSON.stringify(members).includes("scrypt"), "list_members（不含密碼雜湊）", `${members.total}`);

  const out = await post(`/s/${slug}/api/account/logout`, {}, cookie);
  check(out.status === 303, "登出");
  const after = await get(`/s/${slug}/account`, cookie);
  check(after.status === 307 || after.status === 303 || /account\/login/.test(after.location), "登出後同一個 cookie 失效（導回登入）", `${after.status} ${after.location}`);
}

await site.close();
console.log(`\nslug=${slug} order=${orderNo}`);
done();
