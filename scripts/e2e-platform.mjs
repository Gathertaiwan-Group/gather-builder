#!/usr/bin/env node
/**
 * 第九批端到端（只限本機 next start）：
 *  1. 以 Host header 模擬子網域渲染（PLATFORM_SITES_DOMAIN）、租戶 host 上的後台路徑 404
 *  2. /build 選模組（依賴自動帶入）→ 結帳（sandbox：建單得到 303 到 PChomePay sandbox 付款頁，不跟隨、不付款）
 *  3. 模擬權威回查成功（scripts/e2e-platform-settle.mts，同一套 notify 程式、只把回查結果換成已付）→ 自動開站
 *  4. 店主收到邀請（本機 log）→ 設定密碼 → 登入店主後台 → 改內容 → 發布 → 子網域前台看到
 *  5. OAuth 2.1（發現 → 註冊 → 授權（腳本模擬店主登入與同意）→ token → get_site → refresh → 撤銷 → 401），MCP 官方 SDK client
 *  6. 既有手動 Bearer token 仍可用、不觸發 OAuth
 * 用法：APP_URL=http://localhost:3250 PLATFORM_SITES_DOMAIN=sites.test 的 next start 之後
 *   node --env-file=.env.local scripts/e2e-platform.mjs http://localhost:3250 [--sites-domain=sites.test] [--keep]
 * 🔴 不刷卡、不跟隨付款頁、不打正式金流；建立的 is_test 網站與帳號跑完刪除（--keep 保留）。
 */
import { spawnSync } from "node:child_process";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const base = (process.argv[2] ?? "http://localhost:3250").replace(/\/$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("只限本機");
const sitesDomain = (process.argv.find((a) => a.startsWith("--sites-domain=")) ?? "--sites-domain=sites.test").split("=")[1];
const keep = process.argv.includes("--keep");
const port = new URL(base).port;
const SB = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !SK) throw new Error("需要 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY（找訂單、清理）");
const ts = Date.now().toString(36);
const slug = `e2eplat-${ts}`;
const email = `e2e-owner-${ts}@example.com`;
const password = `e2e-${randomBytes(6).toString("hex")}`;

let failed = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failed++;
};
const rest = async (path, init = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

/** 很小的 cookie jar */
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function keepCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (!v || /Max-Age=0/i.test(c)) jar.delete(k);
    else jar.set(k, v);
  }
}
async function req(path, { method = "GET", form, json, host, headers = {}, noCookies = false } = {}) {
  const h = { ...headers };
  if (!noCookies && jar.size) h.cookie = cookieHeader();
  if (host) h.host = host;
  let body;
  if (form) {
    body = new URLSearchParams(form);
    h["content-type"] = "application/x-www-form-urlencoded";
    h.origin ??= host ? `http://${host}` : base;
  }
  if (json) {
    body = JSON.stringify(json);
    h["content-type"] = "application/json";
  }
  if (host) {
    // fetch（undici）不允許自訂 Host header → 改用 node:http 直接送（模擬子網域／自有網域）
    return new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path, method, headers: { ...h, host } }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const sc = [].concat(res.headers["set-cookie"] ?? []);
          const headers = new Headers();
          for (const c of sc) headers.append("set-cookie", c);
          resolve({ status: res.statusCode, location: res.headers.location ?? null, text: data, headers, setCookies: sc });
        });
      });
      r.on("error", reject);
      if (body) r.write(String(body));
      r.end();
    });
  }
  const res = await fetch(`${base}${path}`, { method, headers: h, body, redirect: "manual" });
  if (!noCookies) keepCookies(res);
  return { status: res.status, location: res.headers.get("location"), text: await res.text(), headers: res.headers };
}

const tenantHost = `${slug}.${sitesDomain}:${port}`;

async function cleanup() {
  if (keep) return console.log("（--keep：保留測試資料）");
  const t = await rest(`builder_tenants?select=id&slug=eq.${slug}`);
  if (t?.[0]) await rest(`builder_tenants?id=eq.${t[0].id}`, { method: "DELETE" });
  await rest(`builder_platform_orders?contact_email=eq.${encodeURIComponent(email)}`, { method: "DELETE" });
  await rest(`builder_owner_users?email=eq.${encodeURIComponent(email)}`, { method: "DELETE" });
  await rest(`builder_oauth_clients?client_name=eq.${encodeURIComponent("e2e MCP SDK client")}`, { method: "DELETE" });
  const left = await rest(`builder_tenants?select=id&slug=eq.${slug}`);
  ok("清理測試資料", Array.isArray(left) && left.length === 0);
}

try {
  /* ---------------------------------------------------------------- 1. 子網域 */
  {
    const r = await req("/", { host: `demo-coffee-local.${sitesDomain}:${port}` });
    ok("子網域渲染（Host: demo-coffee-local.<網域>）", r.status === 200 && /rel="canonical" href="http:\/\/demo-coffee-local\./.test(r.text), `HTTP ${r.status}`);
    const p = await req("/s/demo-coffee-local");
    ok("平台 host 的 /s/<slug> 301 到子網域", p.status === 301 && (p.location ?? "").startsWith(`http://demo-coffee-local.${sitesDomain}:${port}`), `${p.status} ${p.location}`);
    const pv = await req("/s/demo-coffee-local?preview=x");
    ok("帶 ?preview= 的 /s/<slug> 不轉址（相容舊預覽）", pv.status === 200);
    for (const path of ["/admin", "/owner", "/build", "/api/mcp", "/.well-known/oauth-protected-resource", "/s/other-site"]) {
      const x = await req(path, { host: `demo-coffee-local.${sitesDomain}:${port}` });
      ok(`租戶 host 上 ${path} → 404`, x.status === 404, `HTTP ${x.status}`);
    }
  }

  /* ---------------------------------------------------------------- 2. /build */
  let order;
  {
    const page = await req("/build");
    ok("/build 列出模組與價格", page.status === 200 && page.text.includes('data-module="shop"') && page.text.includes("前往付款"), `HTTP ${page.status}`);
    const q = await req("/api/build/quote", { method: "POST", json: { modules: ["blog", "contact-form"], price: 1 } });
    const qj = JSON.parse(q.text);
    ok("server 報價：必備 core／sections-basic 自動帶入、首次付款＝建置＋月費", qj.lines?.some((l) => l.id === "core" && l.autoAdded) && qj.firstPayment === qj.setupTotal + qj.monthlyTotal, `首次 ${qj.firstPayment}`);
    const q2 = JSON.parse((await req("/api/build/quote", { method: "POST", json: { modules: ["referral"] } })).text);
    ok("依賴自動帶入（referral → members＋coupons＋shop）", ["members", "coupons", "shop"].every((id) => q2.lines.some((l) => l.id === id && l.autoAdded)));
    const s1 = JSON.parse((await req(`/api/build/slug?slug=${slug}`)).text);
    const s2 = JSON.parse((await req(`/api/build/slug?slug=demo-coffee-local`)).text);
    ok("網址代號檢查（可用／已被使用）", s1.available === true && s2.available === false);
    const co = await req("/api/build/checkout", { method: "POST", form: { modules: "blog", brandName: "E2E 平台測試", slug, themePreset: "minimal-modern", email, price: "1" } });
    ok("結帳 303 到 PChomePay sandbox 付款頁（不跟隨）", co.status === 303 && /^https:\/\/[^/]*sandbox[^/]*pchomepay/i.test(co.location ?? ""), `${co.status} ${(co.location ?? "").replace(/\?.*/, "")}`);
    order = (await rest(`builder_platform_orders?select=*&slug=eq.${slug}`))?.[0];
    ok("平台訂單：server 算價（前端多送的 price 不採信）、sandbox、is_test", !!order && order.amount_total === JSON.parse((await req("/api/build/quote", { method: "POST", json: { modules: ["blog"] } })).text).firstPayment && order.sandbox && order.is_test, order ? `NT$${order.amount_total}` : "沒有訂單");
    const dup = await req("/api/build/checkout", { method: "POST", form: { modules: "blog", brandName: "搶代號", slug, email: `x-${email}` } });
    ok("同代號第二張單被拒", dup.status === 303 && decodeURIComponent(dup.location ?? "").includes("不能用"));
  }

  /* ---------------------------------------------------------------- 3. 模擬權威回查 → 自動開站 */
  let inviteUrl;
  {
    const s = spawnSync("npx", ["tsx", "--env-file=.env.local", "scripts/e2e-platform-settle.mts", order.order_no, base], { encoding: "utf8", env: { ...process.env, RESEND_API_KEY: "" } });
    const out = `${s.stdout}\n${s.stderr}`;
    ok("權威回查（模擬已付）→ 開站", /SETTLE_OUTCOME=paid/.test(out), (/SETTLE_OUTCOME=\S+/.exec(out) ?? ["?"])[0]);
    ok("重複 notify 冪等（already_paid）", /SETTLE_AGAIN=already_paid/.test(out));
    inviteUrl = /(http:\/\/[^\s]+\/owner\/invite\?t=[^\s]+)/.exec(out)?.[1];
    ok("店主收到邀請信（本機 log）", !!inviteUrl);
    const t = (await rest(`builder_tenants?select=id,is_test,platform_order_id&slug=eq.${slug}`)) ?? [];
    ok("只開一個站、is_test、綁平台訂單", t.length === 1 && t[0].is_test && t[0].platform_order_id === order.id);
    const mods = (await rest(`builder_tenant_modules?select=module_id&tenant_id=eq.${t[0]?.id}`)) ?? [];
    ok("所選模組＋依賴已開通", ["core", "sections-basic", "blog"].every((m) => mods.some((x) => x.module_id === m)));
  }

  /* ---------------------------------------------------------------- 4. 店主後台 */
  {
    const t = decodeURIComponent(new URL(inviteUrl).searchParams.get("t"));
    const acc = await req("/api/owner/invite", { method: "POST", form: { token: t, password } });
    ok("設定密碼（接受邀請）", acc.status === 303 && (acc.location ?? "").includes("/owner/login"));
    const login = await req("/api/owner/login", { method: "POST", form: { email, password, next: `/owner/t/${slug}` } });
    ok("店主登入（session cookie host-only）", login.status === 303 && jar.has("gb_owner") && !/domain=/i.test((login.headers.getSetCookie?.() ?? []).join(";")));
    const home = await req(`/owner/t/${slug}`);
    ok("店主後台總覽", home.status === 200 && home.text.includes("E2E 平台測試"));
    const other = await req("/owner/t/demo-coffee-local");
    ok("跨租戶：別人的網站 404", other.status === 404);
    const ed = await req(`/owner/t/${slug}/content`);
    const sid = /name="sectionId" value="([^"]+)"/.exec(ed.text)?.[1];
    const heading = `E2E 店主改的標題 ${ts}`;
    const up = await req(`/api/owner/tenants/${slug}/content`, { method: "POST", form: { action: "update", path: "/", sectionId: sid, props: JSON.stringify({ heading, subheading: "店主後台編輯", align: "center" }) } });
    ok("改內容（只進草稿）", up.status === 303 && decodeURIComponent(up.location ?? "").includes("已儲存到草稿"));
    const before = await req("/", { host: tenantHost });
    ok("發布前子網域前台還看不到（未發布 404 或舊版）", !before.text.includes(heading));
    const ov = await req(`/owner/t/${slug}`);
    const dv = /name="draftVersion" value="(\d+)"/.exec(ov.text)?.[1];
    const pub = await req(`/api/owner/tenants/${slug}/publish`, { method: "POST", form: { note: "e2e", draftVersion: dv, confirm: "on" } });
    ok("發布", pub.status === 303 && decodeURIComponent(pub.location ?? "").includes("已發布"));
    const after = await req("/", { host: tenantHost });
    ok("子網域前台看到新內容", after.status === 200 && after.text.includes(heading), `HTTP ${after.status}`);
    const csrf = await req(`/api/owner/tenants/${slug}/content`, { method: "POST", form: { action: "update" }, headers: { origin: "https://evil.example" } });
    ok("跨站 Origin 的 POST 403", csrf.status === 403);
    globalThis.__ownerReady = true;
  }

  /* ---------------------------------------------------------------- 5／6. OAuth 與既有 Bearer（第九批（4）） */
  try {
    const { runOAuthPart } = await import("./e2e-platform-oauth.mjs");
    failed += await runOAuthPart({ base, slug, email, password, ok, req, jar, rest });
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND") console.log("（OAuth 部分尚未實作，略過）");
    else throw e;
  }
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await cleanup().catch((e) => (console.error("清理失敗", e), failed++));
  console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
  process.exit(failed ? 1 : 0);
}
