#!/usr/bin/env node
// 第五、六批端到端：MCP 開站（is_test）→ 啟用 loyalty／stored-value／i18n／search／directory／downloads／certificates／reviews／announcements →
// 會員付款訂單賺點 → 用點數折抵下一單（金額正確）→ 購買儲值方案（線下匯款 → mark_order_paid 入帳）→ 用儲值金全額付款 →
// 開英文＋AI 翻譯首頁（沒有 GEMINI_API_KEY 時 is_test 用 mock）→ 發布後 /s/<slug>/en 顯示英文且有 hreflang →
// 站內搜尋找得到文章 → 匯入證照並查詢（正確／錯誤訊息一致、不回生日）→ 上傳限會員文件、未登入下載被拒、會員可下載 →
// 買家評價、審核後商品頁顯示 → 必讀公告確認（只記一次）。
// 🔴 不碰真實金流（全部線下匯款／點數／儲值金）、所有 email 用 example.com（不會實際寄出）。
// 用法：node --env-file=.env.local scripts/e2e-content.mjs [baseUrl] [--quick]
//   需要 GB_PLATFORM_TOKEN（含 certificates:*／reviews:write 的平台 token，2026-10-19 後發行）。
import { connect, check, done } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3220";
const quick = args.includes("--quick");
const { GB_PLATFORM_TOKEN: platformToken } = process.env;
if (!platformToken) {
  console.error("需要 GB_PLATFORM_TOKEN");
  process.exit(1);
}
const ts = Date.now().toString(36);
const slug = `e2e-ct-${ts}`;
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
async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(path, cookie) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {}, cache: "no-store" });
  return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text() };
}
const flash = (loc) => {
  const u = new URL(loc || "/", base);
  return { ok: u.searchParams.get("ok"), err: u.searchParams.get("err") };
};
const orderNoFrom = (loc) => decodeURIComponent((/\/orders\/([^?]+)/.exec(loc) ?? [])[1] ?? "");

/* ---------------------------------------------------------------- 開站 */
const platform = await connect(base, platformToken);
const mods = ["sections-basic", "blog", "shop", "members", "loyalty", "stored-value", "i18n", "search", "directory", "downloads", "certificates", "reviews", "announcements"];
const created = await platform.call("create_site", { slug, name: `E2E 內容 ${ts}`, modules: mods, test: true });
check(created.token?.startsWith("gbt_"), "create_site（is_test，13 個模組）", created.__error ?? "");
check(["certificates:write", "reviews:write"].every((s) => created.tokenScopes?.includes(s)), "網站 token 含第六批 scope", created.tokenScopes?.join(","));
await platform.close();
const site = await connect(base, created.token);
const tools = (await site.client.listTools()).tools.map((t) => t.name);
const want = ["get_member_points", "adjust_points", "list_tiers", "update_tiers", "get_member_balance", "adjust_balance", "create_topup_plan", "translate_content", "set_translation", "list_translations", "publish_translations", "create_person", "create_document_upload", "import_certificates", "list_reviews", "moderate_review", "reply_review", "create_announcement", "list_announcement_acks"];
check(want.every((t) => tools.includes(t)), "MCP 有第五、六批工具", want.filter((t) => !tools.includes(t)).join(",") || `${tools.length} 個工具`);

await site.call("configure_module", { moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "請匯款至 測試銀行 000-123456" }, orderPrefix: "CT", shippingFee: 0 } });
await site.call("configure_module", { moduleId: "loyalty", config: { earnPerAmount: 100, pointValue: 1, maxRedeemPercent: 50 } });
await site.call("configure_module", { moduleId: "i18n", config: { languages: ["en"] } });
await site.call("add_section", { path: "/", type: "hero", props: { heading: "歡迎來到山嵐茶行", subheading: "百年老店，台灣高山茶", ctaLabel: "逛商品", ctaHref: "/shop" } });
await site.call("add_section", { path: "/", type: "announcements_list", props: { heading: "最新公告" } });
const prod = await site.call("create_product", { slug: "oolong", name: "高山烏龍禮盒", price: 1000, status: "published", confirm: true });
check(!!prod.id, "create_product（NT$1000，上架）", prod.__error ?? "");
const post1 = await site.call("create_post", { slug: "brew-guide", title: `冷泡茶指南${ts}`, bodyMd: "冷泡要八小時", status: "published", confirm: true });
check(!!post1.id, "create_post（上架）", post1.__error ?? "");
const plan = await site.call("create_topup_plan", { name: "儲 1000 送 100", payAmount: 1000, bonusAmount: 100, bonusExpireDays: 90, status: "published", confirm: true });
check(plan.creditTotal === 1100, "create_topup_plan（付 1000 得 1100）", plan.__error ?? "");
const pv = await site.call("preview_changes");
const pub = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion, note: "e2e content" });
check(pub.revision >= 1, "publish_site", pub.__error ?? "");

/* ---------------------------------------------------------------- 會員 */
const email = `ct-${ts}@example.com`;
const password = `pw-${ts}-secure-xx`;
await post(`/s/${slug}/api/account/register`, { email, password, name: "測試會員", phone: "0912000111" });
const lg = await post(`/s/${slug}/api/account/login`, { email, password });
const cookie = lg.setCookie.split(";")[0];
check(lg.status === 303 && cookie.startsWith("gbm_"), "會員註冊＋登入");
const checkout = (extra = {}) =>
  post(`/s/${slug}/api/shop/checkout`, { items: JSON.stringify([{ productId: prod.id, qty: 1 }]), contactName: "測試會員", contactEmail: email, contactPhone: "0912000111", shipSame: "on", shipAddress: "台中市測試路 1 號", paymentMethod: "offline", ...extra }, cookie);

/* ---------------------------------------------------------------- loyalty：賺點 → 折抵 */
const o1 = await checkout();
const no1 = orderNoFrom(o1.location);
check(o1.status === 303 && !!no1, "結帳 1（線下匯款）", o1.location.slice(0, 120));
const paid1 = await site.call("mark_order_paid", { orderNo: no1, confirm: true });
check(paid1.status === "paid", "mark_order_paid（付款成功那一次賺點）", paid1.__error ?? "");
const pts = await site.call("get_member_points", { email });
check(pts.available === 10, "付款後賺 10 點（1000 ÷ 100）", JSON.stringify({ balance: pts.balance, available: pts.available, err: pts.__error }));
const again = await site.call("mark_order_paid", { orderNo: no1, confirm: true });
check(!!again.__error && (await site.call("get_member_points", { email })).available === 10, "重複 mark_order_paid 被拒、點數不重複");
const o2 = await checkout({ pointsToUse: "10" });
const no2 = orderNoFrom(o2.location);
const ord2 = await site.call("get_order", { orderNo: no2 });
check(ord2.pointsRedeemed === 10 && ord2.pointsDiscount === 10 && ord2.total === 990, "用 10 點折抵下一單：總額 990", JSON.stringify({ total: ord2.total, pts: ord2.pointsRedeemed, err: ord2.__error ?? flash(o2.location).err }));
check((await site.call("get_member_points", { email })).available === 0, "折抵後點數 0（下單交易內扣點）");
const cancel2 = await site.call("cancel_order", { orderNo: no2, confirm: true });
check(cancel2.status === "cancelled" && (await site.call("get_member_points", { email })).available === 10, "取消訂單 → 點數退回 10");

/* ---------------------------------------------------------------- stored-value：儲值 → 用儲值金付款 */
const tp = await post(`/s/${slug}/api/wallet/topup`, { planId: plan.id, name: "測試會員", phone: "0912000111", paymentMethod: "offline" }, cookie);
const tpNo = orderNoFrom(tp.location);
check(tp.status === 303 && !!tpNo, "購買儲值方案（線下匯款）", flash(tp.location).err ?? tp.location.slice(0, 100));
check((await site.call("get_member_balance", { email })).balance === 0, "付款前儲值金 0");
await site.call("mark_order_paid", { orderNo: tpNo, confirm: true });
const bal = await site.call("get_member_balance", { email });
check(bal.balance === 1100 && bal.available === 1100, "mark_order_paid → 儲值金 1100（本金＋贈送）", JSON.stringify({ balance: bal.balance, err: bal.__error }));
const o3 = await checkout({ walletToUse: "1000" });
const no3 = orderNoFrom(o3.location);
const ord3 = await site.call("get_order", { orderNo: no3 });
check(ord3.status === "paid" && ord3.paymentMethod === "credit" && ord3.walletPaid === 1000 && ord3.total === 0, "用儲值金全額付款 → 立即已付款（credit）", JSON.stringify({ status: ord3.status, method: ord3.paymentMethod, wallet: ord3.walletPaid, err: ord3.__error ?? flash(o3.location).err }));
check((await site.call("get_member_balance", { email })).available === 100, "儲值金剩 100");
const acct = await get(`/s/${slug}/account`, cookie);
check(acct.body.includes('data-gb="my-points"') && acct.body.includes('data-gb="my-wallet"'), "會員中心顯示點數與儲值金");

/* ---------------------------------------------------------------- i18n */
const tr = await site.call("translate_content", { lang: "en", target: { type: "page", path: "/" } });
check(tr.draft === true && tr.translated >= 3, "translate_content（進草稿、標記 AI）", tr.__error ?? JSON.stringify(tr.preview ?? {}).slice(0, 160));
const enBefore = await get(`/s/${slug}/en`);
check(enBefore.status === 200 && enBefore.body.includes("歡迎來到山嵐茶行"), "發布前 /en 仍顯示中文（AI 翻譯沒有直接上線）");
const pv2 = await site.call("preview_changes");
check((pv2.changes ?? []).some((c) => /翻譯（en）/.test(c)), "preview_changes 列出翻譯變更", JSON.stringify(pv2.changes ?? pv2.__error).slice(0, 160));
await site.call("publish_site", { confirm: true, expectedDraftVersion: pv2.draftVersion, note: "en" });
const en = await get(`/s/${slug}/en`);
check(en.status === 200 && /<html lang="en"/.test(en.body), "/en：html lang=en");
check(/hreflang="en"/i.test(en.body) && /hreflang="x-default"/i.test(en.body) && /hreflang="zh-Hant-TW"/i.test(en.body), "/en：hreflang（en、zh-Hant-TW、x-default）");
// 沒有 GEMINI_API_KEY 的 is_test 網站用 mock 翻譯（「[en] 原文」）；有 key 時是真的英文（不應再出現中文原句）
const mocked = en.body.includes("[en] 歡迎來到山嵐茶行");
check(mocked || !en.body.includes("歡迎來到山嵐茶行"), `/en 顯示譯文（${mocked ? "mock" : "Gemini"}）`, (/<h1[^>]*>([^<]*)/.exec(en.body) ?? [])[1] ?? "");
check(/href="\/s\/[^"]+\/en\/shop"/.test(en.body), "ctaHref 沒被翻譯（仍是 /shop，帶 /en 前綴）");
check(en.body.includes(`/s/${slug}/en/shop`), "/en 的站內連結維持英文前綴");
check((await get(`/s/${slug}/ja`)).status === 404, "未開啟的語言 /ja → 404");

/* ---------------------------------------------------------------- search */
const sr = await get(`/s/${slug}/search?q=${encodeURIComponent(`冷泡茶指南${ts}`)}`);
check(sr.status === 200 && sr.body.includes(`/s/${slug}/blog/brew-guide`), "站內搜尋找得到文章");

/* ---------------------------------------------------------------- certificates */
const imp = await site.call("import_certificates", { csv: `證號,姓名,生日,類別,發證日,到期日\nCT-${ts}-01,王雅琳,1988-03-12,茶藝師,2026-01-01,2029-01-01\n`, confirm: true });
check(imp.imported === true && imp.inserted === 1, "import_certificates", imp.__error ?? JSON.stringify(imp.errors));
const evil = await site.call("import_certificates", { csv: "證號,姓名,生日\nX-1,=HYPERLINK(\"http://x\"),1990-01-01\n", dryRun: true });
check(evil.imported === false && /疑似公式/.test(evil.errors?.[0] ?? ""), "CSV injection 被拒");
const v1 = await postJson(`/api/s/${slug}/verify`, { certNo: ` ct ${ts} 01 `, name: "王雅琳" });
const v0 = await postJson(`/api/s/${slug}/verify`, { certNo: ` ct ${ts} 01 ` });
check(v0.json?.found === false, "審查 M5：只給證號（沒給姓名）查不到", JSON.stringify(v0.json).slice(0, 120));
check(v1.json?.found === true && v1.json.results[0].name === "王＊琳" && !JSON.stringify(v1.json).includes("1988"), "證照查詢（證號容錯）：姓名遮罩、不回生日", JSON.stringify(v1.json).slice(0, 160));
const v2 = await postJson(`/api/s/${slug}/verify`, { name: "王雅琳", birth: "1988-03-13" });
const v3 = await postJson(`/api/s/${slug}/verify`, { certNo: "NOPE-0000" });
check(v2.json?.found === false && v3.json?.found === false && v2.json.message === v3.json.message, "查無與資料不符回同一句話", v2.json?.message ?? "");

/* ---------------------------------------------------------------- downloads */
const up = await site.call("create_document_upload", { fileName: "會員手冊.pdf", title: "會員手冊", visibility: "members" });
const put = up.uploadUrl ? await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": up.contentType }, body: "%PDF-1.4 e2e" }) : { ok: false };
check(put.ok, "簽名上傳網址直傳檔案", up.__error ?? "");
const comp = await site.call("complete_document_upload", { documentId: up.documentId, publish: true, confirm: true });
check(comp.status === "published", "complete_document_upload（上架）", comp.__error ?? "");
const dlAnon = await get(`/s/${slug}/downloads/${up.documentId}`);
check(dlAnon.status === 303 && dlAnon.location.includes("/account/login"), "限會員文件：未登入下載 → 導到登入");
const dlMember = await get(`/s/${slug}/downloads/${up.documentId}`, cookie);
const file = dlMember.status === 302 ? await fetch(dlMember.location) : null;
check(dlMember.status === 302 && file?.status === 200 && (await file.text()) === "%PDF-1.4 e2e", "會員下載：302 到簽名網址、內容正確");

/* ---------------------------------------------------------------- reviews */
const ord1 = await site.call("get_order", { orderNo: no1 });
const rv = await post(`/s/${slug}/api/reviews`, { productId: prod.id, productSlug: "oolong", orderId: ord1.id, rating: "5", body: `好喝回購${ts}` }, cookie);
check(rv.status === 303 && /審核/.test(flash(rv.location).ok ?? ""), "付款買家送出評價（待審核）", flash(rv.location).err ?? "");
const dup = await post(`/s/${slug}/api/reviews`, { productId: prod.id, productSlug: "oolong", orderId: ord1.id, rating: "1", body: "再一則" }, cookie);
check(!!flash(dup.location).err, "同訂單同商品第二則被拒", flash(dup.location).err ?? "");
const before = await get(`/s/${slug}/shop/oolong`);
check(!before.body.includes(`好喝回購${ts}`), "審核前商品頁不顯示");
const list = await site.call("list_reviews", { status: "pending" });
const mod = await site.call("moderate_review", { reviewId: list.reviews?.[0]?.id, action: "publish", confirm: true });
check(mod.status === "published", "moderate_review（公開）", mod.__error ?? "");
const after = await get(`/s/${slug}/shop/oolong`);
const plain = after.body.replace(/<!-- -->/g, "");
check(plain.includes(`好喝回購${ts}`) && /5 \/ 5（1 則）/.test(plain), "商品頁顯示評價與平均分");

/* ---------------------------------------------------------------- announcements */
const ann = await site.call("create_announcement", { title: `會員大會必讀${ts}`, bodyMd: "請準時出席", audience: "members", requireAck: true, status: "published", confirm: true });
check(ann.live === true, "create_announcement（必讀、僅會員、上線）", ann.__error ?? "");
const home = await get(`/s/${slug}`, cookie);
check(home.body.includes('data-gb="must-read"') && home.body.includes(`會員大會必讀${ts}`), "會員看到必讀公告");
check(!(await get(`/s/${slug}`)).body.includes(`會員大會必讀${ts}`), "訪客看不到僅會員公告");
const ack = await post(`/s/${slug}/api/announcements/ack`, { id: ann.id, back: "/" }, cookie);
const ack2 = await post(`/s/${slug}/api/announcements/ack`, { id: ann.id, back: "/" }, cookie);
check(ack.status === 303 && ack2.status === 303, "按確認（重複按也可以）");
check(!(await get(`/s/${slug}`, cookie)).body.includes('data-gb="must-read"'), "確認後不再顯示必讀");
const acks = await site.call("list_announcement_acks", { announcementId: ann.id });
check(acks.total === 1 && /＊/.test(acks.acks?.[0]?.email ?? ""), "確認名單 1 人（只記一次、email 遮罩）");

await site.close();
done();
