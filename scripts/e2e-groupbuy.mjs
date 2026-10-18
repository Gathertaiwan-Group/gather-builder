#!/usr/bin/env node
// 第八批端到端：MCP 開站（is_test）→ 啟用 shop＋group-buy＋i18n＋qr-catalog →
// 團購（限量 2、團主分潤 10%）→ 兩位顧客經團主連結免登入下單（銀行轉帳）→ 第三單超過限量被拒 →
// 匯入銀行明細 CSV → 建議配對（訂單不變）→ confirm_bank_matches → 分潤正確 → close_group_buy → export_shipping → 團主報表正確且遮罩；
// QR：產生標籤 → 模擬 Accept-Language: ja＋x-vercel-ip-country: JP 掃碼 → 落地頁日文 → 海外寄送詢價 → 掃描報表 JP×ja 一筆＋一筆詢價轉換 →
// 品牌報表連結可看、撤銷後不可看。
// 🔴 不碰真實金流（全部銀行轉帳＝線下匯款）；所有 email 用 example.com（不會實際寄出）。
// 用法：node --env-file=.env.local scripts/e2e-groupbuy.mjs [baseUrl] [--quick] [--no-qr]
//   需要 GB_PLATFORM_TOKEN。正式站（非 localhost）上 x-vercel-ip-country 由 Vercel 依來源 IP 設定，國家碼不一定是 JP（腳本會放寬檢查）。
import { connect, check, done } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3240";
const quick = args.includes("--quick");
const noQr = args.includes("--no-qr");
const local = /localhost|127\.0\.0\.1/.test(base);
const { GB_PLATFORM_TOKEN: platformToken } = process.env;
if (!platformToken) {
  console.error("需要 GB_PLATFORM_TOKEN");
  process.exit(1);
}
const ts = Date.now().toString(36);
const slug = `e2e-gb-${ts}`;
console.log(`base=${base} slug=${slug}${quick ? " (quick)" : ""}\n`);

async function post(path, fields, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers }, body: new URLSearchParams(fields).toString() });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}
async function get(path, headers = {}, redirect = "manual") {
  const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, { redirect, headers, cache: "no-store" });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "", body: await res.text(), url: res.url };
}
const flash = (loc) => {
  const u = new URL(loc || "/", base);
  return { ok: u.searchParams.get("ok"), err: u.searchParams.get("err") };
};
const orderNoFrom = (loc) => decodeURIComponent((/\/orders\/([^?]+)/.exec(loc) ?? [])[1] ?? "");

/* ---------------------------------------------------------------- 開站 */
const platform = await connect(base, platformToken);
const mods = ["sections-basic", "shop", "group-buy", "i18n", ...(noQr ? [] : ["qr-catalog"])];
const created = await platform.call("create_site", { slug, name: `E2E 團購 ${ts}`, modules: mods, test: true });
check(created.token?.startsWith("gbt_"), `create_site（is_test，${mods.join("＋")}）`, created.__error ?? "");
await platform.close();
const site = await connect(base, created.token);
const tools = (await site.client.listTools()).tools.map((t) => t.name);
const want = ["create_group_buy", "update_group_buy", "duplicate_group_buy", "invite_leader", "list_group_buy_orders", "import_bank_statement", "confirm_bank_matches", "close_group_buy", "export_shipping", ...(noQr ? [] : ["generate_qr_labels", "get_scan_report", "create_brand_report_link", "revoke_brand_report_link"])];
check(want.every((t) => tools.includes(t)), "MCP 有第八批工具", want.filter((t) => !tools.includes(t)).join(",") || `${tools.length} 個工具`);

await site.call("configure_module", { moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "請匯款至 測試銀行 000-123456" }, orderPrefix: "GB", shippingFee: 100 } });
await site.call("configure_module", { moduleId: "i18n", config: { languages: ["en", "ja"] } });
const prod = await site.call("create_product", { slug: "oolong", name: "高山烏龍禮盒", price: 1000, status: "published", confirm: true, ...(noQr ? {} : { brand: "山嵐茶行" }) });
check(!!prod.id, "create_product（NT$1000）", prod.__error ?? "");
const gb = await site.call("create_group_buy", {
  slug: "oolong-gb",
  title: "高山烏龍秋季團",
  endsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
  pickupPoints: [{ id: "huashan", name: "小時光華山店", address: "台北市中正區八德路一段 1 號" }],
  items: [{ productId: prod.id, price: 800, quota: 2 }],
  status: "published",
  confirm: true,
});
check(gb.status === "published" && gb.items?.[0]?.quota === 2, "create_group_buy（團購價 800、限量 2、上架）", gb.__error ?? "");
const itemId = gb.items?.[0]?.id;
const lead = await site.call("invite_leader", { groupBuyId: gb.id, name: "阿美團長", email: `leader-${ts}@example.com`, commissionPercent: 10 });
check(!!lead.code && lead.shareUrl?.includes(`leader=${lead.code}`) && !!lead.reportUrl, "invite_leader（分潤 10%）", lead.__error ?? "");
await site.call("add_section", { path: "/", type: "group_buy_list", props: { heading: "開團中", limit: 6, showClosed: false } });
const pv = await site.call("preview_changes");
const pub = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion, note: "e2e groupbuy" });
check(pub.revision >= 1, "publish_site", pub.__error ?? "");

const home = await get(`/s/${slug}`);
check(home.status === 200 && home.body.includes("高山烏龍秋季團"), "首頁團購列表");
const page = await get(`/s/${slug}/groupbuy/oolong-gb?leader=${lead.code}`);
check(page.status === 200 && page.body.includes("阿美團長") && page.body.includes(`name="qty_${itemId}"`), "團購頁（團主參數 → 顯示團主、品項）");

/* ---------------------------------------------------------------- 兩位顧客免登入下單（銀行轉帳） */
const buyers = [
  { name: "王小明", email: `buyer1-${ts}@example.com`, phone: "0912000111", last5: "11111", ship: "pickup:huashan", addr: "" },
  { name: "陳大文", email: `buyer2-${ts}@example.com`, phone: "0912000222", last5: "22222", ship: "", addr: "台中市西屯區測試路 2 號" },
];
const placed = [];
for (const b of buyers) {
  const r = await post(`/s/${slug}/api/groupbuy/order`, { groupBuy: "oolong-gb", leader: lead.code, [`qty_${itemId}`]: "1", name: b.name, email: b.email, phone: b.phone, ...(b.ship ? { ship: b.ship } : {}), shipAddress: b.addr, paymentMethod: "offline", payerLast5: b.last5 });
  const no = orderNoFrom(r.location);
  placed.push(no);
  check(r.status === 303 && !!no, `${b.name} 經團主連結下單（銀行轉帳）`, flash(r.location).err ?? r.location.slice(0, 100));
}
const over = await post(`/s/${slug}/api/groupbuy/order`, { groupBuy: "oolong-gb", [`qty_${itemId}`]: "1", name: "第三人", email: `buyer3-${ts}@example.com`, phone: "0912000333", ship: "pickup:huashan", paymentMethod: "offline" });
check(over.status === 303 && /已達上限|已售完/.test(flash(over.location).err ?? ""), "第三單超過限量被拒", flash(over.location).err ?? over.location);
const lo = await site.call("list_group_buy_orders", { groupBuyId: gb.id });
const totals = Object.fromEntries((lo.orders ?? []).map((o) => [o.orderNo, o.total]));
check(lo.total === 2 && lo.orders.every((o) => o.status === "pending_payment" && o.leader?.name === "阿美團長"), "list_group_buy_orders：2 張待付款、都標團主", lo.__error ?? JSON.stringify(lo.orders?.map((o) => o.status)));
check(totals[placed[0]] === 800 && totals[placed[1]] === 900, "團購價 server 計：自取 800、宅配 800＋運費 100", JSON.stringify(totals));

/* ---------------------------------------------------------------- 銀行明細對帳 */
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const csv = `日期,金額,帳號末五碼,備註\n${today},800,0000011111,王小明\n${today},900,22222,\n${today},1234,99999,不相干的入帳\n`;
const imp = await site.call("import_bank_statement", { csv, filename: "bank.csv" });
check(imp.rows === 3 && imp.suggestions?.length === 2 && imp.unmatched === 1, "import_bank_statement：2 筆建議配對、1 筆找不到", imp.__error ?? JSON.stringify({ s: imp.suggestions?.length, u: imp.unmatched }));
const still = await site.call("list_group_buy_orders", { groupBuyId: gb.id });
check(still.orders?.every((o) => o.status === "pending_payment"), "匯入只產生建議：訂單仍待付款");
const inj = await site.call("import_bank_statement", { csv: `日期,金額,帳號末五碼,備註\n${today},800,11111,=HYPERLINK("http://evil")\n` });
check(!!inj.__error && /不能以/.test(inj.__error), "CSV injection 整份拒絕", inj.__error ?? "");
const noConfirm = await site.call("confirm_bank_matches", { matchIds: imp.suggestions.map((s) => s.matchId) });
check(!!noConfirm.__error && noConfirm.__error.startsWith("[confirm_required]"), "confirm_bank_matches 沒 confirm 被拒");
const conf = await site.call("confirm_bank_matches", { matchIds: imp.suggestions.map((s) => s.matchId), confirm: true });
check(conf.results?.filter((r) => r.ok).length === 2, "confirm_bank_matches（confirm）→ 2 張標記已收款", conf.__error ?? JSON.stringify(conf.results));
const paidList = await site.call("list_group_buy_orders", { groupBuyId: gb.id });
check(paidList.orders?.every((o) => o.status === "paid"), "兩張訂單已付款");
check(paidList.orders?.find((o) => o.orderNo === placed[0])?.commission === 80 && paidList.orders?.find((o) => o.orderNo === placed[1])?.commission === 80, "團主分潤 10%（基數＝商品實付 800，不含運費）＝各 80", JSON.stringify(paidList.orders?.map((o) => o.commission)));
const dup = await site.call("confirm_bank_matches", { matchIds: [imp.suggestions[0].matchId], confirm: true });
check(dup.results?.[0]?.ok === false, "同一筆配對不能確認兩次");

/* ---------------------------------------------------------------- 結團、出貨匯出、團主報表 */
const close = await site.call("close_group_buy", { groupBuyId: gb.id, confirm: true });
check(close.status === "closed", "close_group_buy（confirm）→ 成團結團", close.__error ?? close.status);
const exp = await site.call("export_shipping", { groupBuyId: gb.id, reason: "e2e 出貨" });
check(exp.rows === 2 && exp.csv?.includes("小時光華山店") && exp.csv?.includes("台中市西屯區測試路 2 號"), "export_shipping：2 筆（自取點＋宅配地址）", exp.__error ?? "");
const report = await get(new URL(lead.reportUrl).pathname + new URL(lead.reportUrl).search);
check(report.status === 200 && report.body.includes("王＊明") && report.body.includes("陳＊文"), "團主報表：2 筆、買家姓名遮罩", String(report.status));
check(!report.body.includes(buyers[0].email) && !report.body.includes("0912000111") && !report.body.includes("西屯區"), "團主報表：不含 email、電話、地址");
check(/NT\$160/.test(report.body), "團主報表：分潤合計 NT$160");
check((await get(`/s/${slug}/groupbuy/leader?l=${new URL(lead.reportUrl).searchParams.get("l")}&t=${"x".repeat(32)}`)).status === 404, "團主報表：簽章錯 → 404");
const closedPage = await get(`/s/${slug}/groupbuy/oolong-gb`);
check(closedPage.body.includes('data-gb="groupbuy-closed"'), "結團後團購頁不再提供下單");
if (!quick) {
  const d = await site.call("duplicate_group_buy", { groupBuyId: gb.id });
  check(d.status === "draft" && d.items?.[0]?.price === 800 && d.items?.[0]?.sold === 0, "duplicate_group_buy：新草稿、團購價保留、已售歸零", d.__error ?? "");
}

/* ---------------------------------------------------------------- QR 多語商品頁 */
if (!noQr) {
  await site.call("set_translation", { lang: "ja", target: { type: "product", id: prod.id }, fields: { name: "高山烏龍茶ギフトボックス", description_md: "台湾の高山茶" } });
  await site.call("publish_translations", { lang: "ja", confirm: true });
  await site.call("configure_module", { moduleId: "qr-catalog", config: { currencies: [{ code: "JPY", rate: 4.7 }] } });
  const pv2 = await site.call("preview_changes");
  await site.call("publish_site", { confirm: true, expectedDraftVersion: pv2.draftVersion, note: "qr" });
  const labels = await site.call("generate_qr_labels", { productIds: [prod.id] });
  const code = labels.labels?.[0]?.code;
  check(/^[A-Za-z0-9]{10}$/.test(code ?? "") && labels.labels[0].url.endsWith(`/s/${slug}/q/${code}`) && labels.labels[0].svg?.startsWith("<svg"), "generate_qr_labels：隨機短碼＋SVG", labels.__error ?? "");
  const sheet = await get(new URL(labels.labelsUrl).pathname + new URL(labels.labelsUrl).search);
  check(sheet.status === 200 && sheet.body.includes("高山烏龍禮盒") && sheet.body.includes("<svg"), "A4 標籤頁（商品名、價格、QR）", String(sheet.status));
  const scan = await get(`/s/${slug}/q/${code}`, { "accept-language": "ja-JP,ja;q=0.9,en;q=0.8", "x-vercel-ip-country": "JP" });
  check(scan.status === 303 && scan.location.includes(`/s/${slug}/ja/q/${code}/view`), "掃碼（Accept-Language: ja）→ 導到日文落地頁", `${scan.status} ${scan.location}`);
  const qrCookie = scan.setCookie.split(";")[0];
  const land = await get(new URL(scan.location, base).pathname, { cookie: qrCookie });
  check(land.status === 200 && land.body.includes("高山烏龍茶ギフトボックス") && /<html lang="ja"/.test(land.body), "落地頁：日文商品名、html lang=ja", String(land.status));
  check(land.body.includes("¥") && /参考/.test(land.body), "落地頁：外幣約當（僅供參考）");
  const inq = await post(`/s/${slug}/api/qr/inquiry`, { code, lang: "ja", name: "山田太郎", email: `yamada-${ts}@example.com`, country: "JP", address: "東京都千代田区1-1", message: "日本に送ってほしい" }, { cookie: qrCookie });
  check(inq.status === 303 && !!flash(inq.location).ok, "海外寄送詢價送出", flash(inq.location).err ?? inq.location);
  const rep = await site.call("get_scan_report", {});
  const row = (rep.rows ?? []).find((r) => r.productId === prod.id && r.lang === "ja");
  check(!!row && row.scans === 1 && row.inquiries === 1 && (local ? row.country === "JP" : true), `掃描報表：${local ? "JP×ja" : "ja"} 1 次掃描、1 筆詢價轉換`, JSON.stringify(rep.rows ?? rep.__error));
  const link = await site.call("create_brand_report_link", { brand: "山嵐茶行", expiresInDays: 30, confirm: true });
  check(!!link.url && !!link.linkId, "create_brand_report_link（confirm）", link.__error ?? "");
  const br = await get(new URL(link.url).pathname);
  check(br.status === 200 && br.body.includes("高山烏龍禮盒") && !br.body.includes(`yamada-${ts}`) && !br.body.includes(buyers[0].email), "品牌報表：看得到自家商品統計、不含個資", String(br.status));
  const rv = await site.call("revoke_brand_report_link", { linkId: link.linkId });
  check(rv.revoked === true, "revoke_brand_report_link", rv.__error ?? "");
  check((await get(new URL(link.url).pathname)).status === 404, "撤銷後品牌報表 404");
}

await site.close();
done();
