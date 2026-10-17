#!/usr/bin/env node
// 隔離與權限、聯絡表單、後台撤銷 token 的端到端檢查。
// 用法：node --env-file=.env.local scripts/e2e-security.mjs [baseUrl]
//   需要 GB_PLATFORM_TOKEN、ADMIN_PASSWORD。
import { connect, check, done, getText } from "./mcp-client.mjs";

const base = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "http://localhost:3100";
const P = process.env.GB_PLATFORM_TOKEN;
const PW = process.env.ADMIN_PASSWORD;
if (!P || !PW) {
  console.error("需要 GB_PLATFORM_TOKEN 與 ADMIN_PASSWORD");
  process.exit(1);
}
const ts = Date.now().toString(36);
const A = `sec-a-${ts}`;
const B = `sec-b-${ts}`;

/* ---------- 1. 沒帶 token / 錯 token → 401 ---------- */
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const r0 = await fetch(`${base}/api/mcp`, { method: "POST", headers: hdr, body: JSON.stringify(init) });
check(r0.status === 401 && !/resource_metadata/.test(r0.headers.get("www-authenticate") ?? ""), "沒帶 token → 401（不帶 OAuth resource_metadata）", `HTTP ${r0.status} www-authenticate=${r0.headers.get("www-authenticate")}`);
const r1 = await fetch(`${base}/api/mcp`, { method: "POST", headers: { ...hdr, authorization: "Bearer gbt_not_a_real_token_xxxxxxxxxxxx" }, body: JSON.stringify(init) });
check(r1.status === 401, "錯誤 token → 401", `HTTP ${r1.status}`);
const wk = await fetch(`${base}/.well-known/oauth-protected-resource`);
check(wk.status === 404, "沒有 /.well-known/oauth-protected-resource", `HTTP ${wk.status}`);

/* ---------- 2. 跨租戶隔離 ---------- */
const platform = await connect(base, P);
const sa = await platform.call("create_site", { slug: A, name: "安全測試 A", modules: ["sections-basic", "contact-form"], test: true });
const sb = await platform.call("create_site", { slug: B, name: "安全測試 B", test: true });
check(!!sa.token && !!sb.token, "建立租戶 A、B", sa.__error ?? sb.__error ?? "");

const a = await connect(base, sa.token);
const g = await a.call("get_site", { site: B });
check(g.__error?.startsWith("[forbidden]"), "A 的 token 讀 B 被拒", g.__error);
const w = await a.call("add_section", { site: B, path: "/", type: "hero", props: { heading: "入侵" } });
check(w.__error?.startsWith("[forbidden]"), "A 的 token 改 B 被拒", w.__error);
const cs = await a.call("create_site", { slug: `sec-c-${ts}`, name: "C" });
check(cs.__error?.startsWith("[forbidden]"), "租戶 token 不能 create_site", cs.__error);
const own = await a.call("get_site");
check(own.slug === A, "A 的 token 讀自己 OK");

/* ---------- 3. scope 不足 ---------- */
const ro = await platform.call("issue_site_token", { site: A, name: "read only", scopes: ["site:read"] });
check(ro.token?.startsWith("gbt_"), "發行只有 site:read 的 token", ro.__error ?? "");
const roc = await connect(base, ro.token);
const rr = await roc.call("get_site");
check(rr.slug === A, "site:read token 可以 get_site");
const rw = await roc.call("add_section", { path: "/", type: "hero", props: { heading: "x" } });
check(rw.__error?.startsWith("[forbidden]") && rw.__error.includes("content:write"), "site:read token 呼叫 add_section 被拒", rw.__error);
const rp = await roc.call("publish_site", { confirm: true });
check(rp.__error?.includes("publish"), "site:read token 呼叫 publish_site 被拒", rp.__error?.slice(0, 50));
await roc.close();

/* ---------- 4. 聯絡表單 + honeypot ---------- */
const cf = await a.call("add_section", { path: "/", type: "contact_form", props: { heading: "聯絡" } });
const pub = await a.call("publish_site", { confirm: true });
check(!!cf.sectionId && pub.revision === 1, "A 加聯絡表單並發布", cf.__error ?? pub.__error ?? "");
const page = await getText(`${base}/s/${A}`);
check(page.body.includes('name="website"'), "前台表單含 honeypot 欄位");
const human = `真人 ${ts}`;
const bot = `機器人 ${ts}`;
const post = (data) =>
  fetch(`${base}/api/s/${A}/inquiry`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 200)}.1` }, body: JSON.stringify(data) });
const okRes = await post({ name: human, email: "human@example.com", message: "想詢問報價", path: "/" });
check(okRes.status === 200, "正常送出 → 200", `HTTP ${okRes.status}`);
const botRes = await post({ name: bot, email: "bot@example.com", message: "spam", website: "http://spam.example" });
check(botRes.status === 200, "honeypot 送出也回 200（不讓機器人知道）", `HTTP ${botRes.status}`);
const badRes = await post({ name: "x", email: "not-an-email", message: "x" });
check(badRes.status === 400, "Email 格式錯誤 → 400", `HTTP ${badRes.status}`);
const inq = await a.call("list_inquiries");
check(Array.isArray(inq) && inq.some((i) => i.name === human) && !inq.some((i) => i.name === bot), "list_inquiries 讀得到真人、沒有 honeypot 那筆", `共 ${inq.length} 筆`);
const noInq = await connect(base, ro.token);
const ni = await noInq.call("list_inquiries");
check(ni.__error?.includes("inquiries:read"), "沒有 inquiries:read 的 token 讀詢問被拒");
await noInq.close();

/* ---------- 5. 限流 ---------- */
const fixedIp = `10.77.${Math.floor(Math.random() * 200)}.9`;
let last = 0;
for (let i = 0; i < 6; i++) {
  const r = await fetch(`${base}/api/s/${A}/inquiry`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": fixedIp }, body: JSON.stringify({ name: `限流 ${i}`, email: "r@example.com", message: "x" }) });
  last = r.status;
}
check(last === 429, "同一 IP 第 6 次送出 → 429", `HTTP ${last}`);

/* ---------- 6. 後台：登入、看得到租戶與版本、撤銷 token ---------- */
const bad = await fetch(`${base}/api/admin/login`, { method: "POST", body: new URLSearchParams({ password: "wrong" }), redirect: "manual" });
check(bad.status === 303 && (bad.headers.get("location") ?? "").includes("err="), "後台錯誤密碼被拒");
const noAuth = await fetch(`${base}/admin`, { redirect: "manual" });
check(noAuth.status === 307 || noAuth.status === 308 || noAuth.status === 302, "未登入 /admin 被導去登入", `HTTP ${noAuth.status}`);
const login = await fetch(`${base}/api/admin/login`, { method: "POST", body: new URLSearchParams({ password: PW }), redirect: "manual" });
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
check(login.status === 303 && cookie.startsWith("gb_admin="), "後台登入成功取得 session cookie");
const home = await fetch(`${base}/admin`, { headers: { cookie } }).then((r) => r.text());
check(home.includes(A) && home.includes(B), "後台網站列表看得到 e2e 建出的租戶");
const detail = await fetch(`${base}/admin/t/${A}`, { headers: { cookie } }).then((r) => r.text());
check(detail.includes('data-admin="revision-row"') && detail.includes(human), "後台租戶頁看得到版本列表與詢問");

const victim = await platform.call("issue_site_token", { site: A, name: "will be revoked", scopes: ["site:read"] });
const vc = await connect(base, victim.token);
check((await vc.call("get_site")).slug === A, "待撤銷 token 原本可用");
await vc.close().catch(() => {});
const rev = await fetch(`${base}/api/admin/tokens/${victim.id}/revoke`, { method: "POST", headers: { cookie, referer: `${base}/admin/t/${A}` }, body: new URLSearchParams({}), redirect: "manual" });
check(rev.status === 303 && (rev.headers.get("location") ?? "").includes("ok="), "後台撤銷 token", `HTTP ${rev.status}`);
const after = await fetch(`${base}/api/mcp`, { method: "POST", headers: { ...hdr, authorization: `Bearer ${victim.token}` }, body: JSON.stringify(init) });
check(after.status === 401, "撤銷後呼叫 MCP → 401", `HTTP ${after.status}`);
const csrf = await fetch(`${base}/api/admin/tokens/${victim.id}/revoke`, { method: "POST", headers: { cookie, origin: "https://evil.example" }, redirect: "manual" });
check(csrf.status === 403, "跨站 Origin 的後台 POST 被擋", `HTTP ${csrf.status}`);

await a.close();
await platform.close();
console.log(`\nslugs=${A},${B}`);
done();
