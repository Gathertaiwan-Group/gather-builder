/**
 * 第九批（1）：子網域與自有網域。
 * - 三種網址（/s/<slug>、<slug>.<網域>、自有網域）都對應到同一個租戶；未驗證（pending／verified）的網域不生效。
 * - Host header 偽造：租戶 host 上帶別人的 /s/<slug> 或 /api/s/<slug> 一律 404；不認得的 host 404。
 * - 平台後台、店主後台、/build、OAuth、MCP 在租戶 host 上 404（後台與租戶不同源）。
 * - 會員 cookie：租戶 host 上 host-only（不帶 Domain、path /）；路徑模式 path /s/<slug>。
 * - 集中產生網址（siteBase／siteUrl／預覽／canonical）。
 * - 自有網域服務：mock adapter（🔴 不打 Vercel API）、權限（只有後台／店主 owner）、驗證後才能啟用、啟用改正式網址。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { publishSite, previewChanges } from "@/lib/services/publish";
import { classifyHost, decideRoute, hostConfigFromEnv, type HostConfig } from "@/lib/host-routing";
import { storeRoutingLookup } from "@/lib/domain-routing";
import { siteBase, siteCookiePath, siteUrl } from "@/lib/site-url";
import { clearMemberCookie, setMemberCookie } from "@/lib/site-request";
import { mockTxtVerifier, createMockDomainAdapter, createVercelDomainAdapter, isApex, pointingRecords } from "@/lib/domains/adapter";
import { activateDomain, addDomain, checkDomain, listDomains, removeDomain, sweepPendingDomains } from "@/lib/services/domains";
import type { Store, TenantRow } from "@/lib/store/types";
import type { Actor } from "@/lib/tokens";
import { TENANT_SCOPES } from "@/lib/scopes";

const cfg: HostConfig = { platformHosts: ["builder.example", "localhost"], sitesDomain: "sites.example" };
const route = (store: Store, host: string, pathname: string, opts: { search?: string; method?: string } = {}) =>
  decideRoute({ host, pathname, search: opts.search ?? "", method: opts.method ?? "GET", proto: "https", port: null }, cfg, storeRoutingLookup(store));

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});
afterEach(() => {
  delete process.env.PLATFORM_SITES_DOMAIN;
});

async function twoSites() {
  const store = newStore();
  const ctx = ctxFor(store);
  await createSite(ctx, { slug: "lin-bakery", name: "林家烘焙" });
  await createSite(ctx, { slug: "other-shop", name: "別人的店" });
  await publishSite(ctx, { site: "lin-bakery", confirm: true }).catch(() => undefined);
  const mock = createMockDomainAdapter();
  const a = (await store.getTenantBySlug("lin-bakery"))!;
  const b = (await store.getTenantBySlug("other-shop"))!;
  return { store, ctx, mock, a, b };
}

describe("Host 解析", () => {
  it("classifyHost：平台、子網域、自有網域、保留子網域、IP、vercel.app", () => {
    expect(classifyHost("builder.example", cfg)).toEqual({ kind: "platform" });
    expect(classifyHost("BUILDER.example:443", cfg)).toEqual({ kind: "platform" });
    expect(classifyHost("lin-bakery.sites.example", cfg)).toEqual({ kind: "subdomain", slug: "lin-bakery" });
    expect(classifyHost("admin.sites.example", cfg)).toEqual({ kind: "invalid" });
    expect(classifyHost("a.b.sites.example", cfg)).toEqual({ kind: "invalid" });
    expect(classifyHost("shop.lin.tw", cfg)).toEqual({ kind: "custom", domain: "shop.lin.tw" });
    expect(classifyHost("10.0.0.1", cfg)).toEqual({ kind: "invalid" });
    expect(classifyHost("gather-builder-abc.vercel.app", cfg)).toEqual({ kind: "platform" });
    expect(classifyHost("evil host", cfg)).toEqual({ kind: "invalid" });
    expect(hostConfigFromEnv({ APP_URL: "https://gather-builder.vercel.app", PLATFORM_SITES_DOMAIN: "Sites.Gathertaiwan.com", PLATFORM_EXTRA_HOSTS: "builder.gathertaiwan.com" })).toMatchObject({ sitesDomain: "sites.gathertaiwan.com", platformHosts: expect.arrayContaining(["gather-builder.vercel.app", "builder.gathertaiwan.com"]) });
  });

  it("三種網址對應同一租戶：/s/<slug>（平台 host）、子網域、自有網域（active）", async () => {
    const s = await twoSites();
    // 子網域
    expect(await route(s.store, "lin-bakery.sites.example", "/about")).toEqual({ type: "rewrite", pathname: "/s/lin-bakery/about", slug: "lin-bakery", origin: "https://lin-bakery.sites.example" });
    expect(await route(s.store, "lin-bakery.sites.example", "/")).toMatchObject({ type: "rewrite", pathname: "/s/lin-bakery" });
    // 舊連結（/s/<自己>/…）在租戶 host 上照常可用
    expect(await route(s.store, "lin-bakery.sites.example", "/s/lin-bakery/shop")).toMatchObject({ type: "rewrite", pathname: "/s/lin-bakery/shop" });
    expect(await route(s.store, "lin-bakery.sites.example", "/en/about")).toMatchObject({ type: "rewrite", pathname: "/s/lin-bakery/en/about" });
    expect(await route(s.store, "lin-bakery.sites.example", "/api/s/lin-bakery/inquiry", { method: "POST" })).toMatchObject({ type: "rewrite", pathname: "/api/s/lin-bakery/inquiry" });
    // 自有網域：加入 → 驗證 → 啟用後才生效
    const d = await addDomain(s.ctx, { site: "lin-bakery", domain: "shop.lin.test" }, s.mock);
    expect(await route(s.store, "shop.lin.test", "/")).toEqual({ type: "notfound" }); // pending
    await checkDomain(s.ctx, { site: "lin-bakery", domainId: d.id }, s.mock, mockTxtVerifier);
    expect((await s.store.getTenantDomain(s.a.id, d.id))!.status).toBe("verified");
    expect(await route(s.store, "shop.lin.test", "/")).toEqual({ type: "notfound" }); // verified 但未啟用
    await activateDomain(s.ctx, { site: "lin-bakery", domainId: d.id, confirm: true });
    expect(await route(s.store, "shop.lin.test", "/about")).toEqual({ type: "rewrite", pathname: "/s/lin-bakery/about", slug: "lin-bakery", origin: "https://shop.lin.test" });
    // 啟用自有網域後，子網域 GET 301 到自有網域（API 不轉）
    expect(await route(s.store, "lin-bakery.sites.example", "/about", { search: "?x=1" })).toEqual({ type: "redirect", location: "https://shop.lin.test/about?x=1", status: 301 });
    expect(await route(s.store, "lin-bakery.sites.example", "/s/lin-bakery/api/account/login", { method: "POST" })).toMatchObject({ type: "rewrite" });
    // 平台 host 的 /s/<slug>：啟用子網域後 GET 301 到正式網址；預覽與 API 不轉
    expect(await route(s.store, "builder.example", "/s/other-shop/about")).toEqual({ type: "redirect", location: "https://other-shop.sites.example/about", status: 301 });
    expect(await route(s.store, "builder.example", "/s/lin-bakery")).toEqual({ type: "redirect", location: "https://shop.lin.test/", status: 301 });
    expect(await route(s.store, "builder.example", "/s/lin-bakery", { search: "?preview=abc" })).toEqual({ type: "next" });
    expect(await route(s.store, "builder.example", "/s/lin-bakery/api/account/login", { method: "POST" })).toEqual({ type: "next" });
    expect(await route(s.store, "builder.example", "/s/lin-bakery/en/api/x")).toEqual({ type: "next" });
    // 沒啟用子網域（PLATFORM_SITES_DOMAIN 未設）：/s/<slug> 照舊 200（正式站現況）
    const noSub = await decideRoute({ host: "builder.example", pathname: "/s/lin-bakery", search: "", method: "GET", proto: "https", port: null }, { ...cfg, sitesDomain: null }, storeRoutingLookup(s.store));
    expect(noSub).toEqual({ type: "next" });
  });

  it("Host header 偽造：租戶 host 上讀不到別的租戶；不存在的子網域／網域 404", async () => {
    const s = await twoSites();
    expect(await route(s.store, "lin-bakery.sites.example", "/s/other-shop")).toEqual({ type: "notfound" });
    expect(await route(s.store, "lin-bakery.sites.example", "/s/other-shop/account")).toEqual({ type: "notfound" });
    expect(await route(s.store, "lin-bakery.sites.example", "/api/s/other-shop/inquiry", { method: "POST" })).toEqual({ type: "notfound" });
    expect(await route(s.store, "nobody.sites.example", "/")).toEqual({ type: "notfound" });
    expect(await route(s.store, "random-domain.test", "/")).toEqual({ type: "notfound" });
    // 別人的網域即使加到自己名下也要驗證＋啟用；同一網域不能被兩個租戶加
    await addDomain(s.ctx, { site: "other-shop", domain: "taken.test" }, s.mock);
    await expect(addDomain(s.ctx, { site: "lin-bakery", domain: "taken.test" }, s.mock)).rejects.toMatchObject({ code: "conflict" });
  });

  it("後台與租戶不同源：/admin、/owner、/build、/oauth、/api/mcp、/.well-known、/p 在租戶 host 上一律 404", async () => {
    const s = await twoSites();
    for (const p of ["/admin", "/admin/t/lin-bakery", "/api/admin/tokens", "/owner", "/owner/t/lin-bakery", "/api/owner/x", "/build", "/oauth/authorize", "/api/mcp", "/.well-known/oauth-protected-resource", "/p/n/abc", "/api/cron/expire-orders"]) {
      expect(await route(s.store, "lin-bakery.sites.example", p), p).toEqual({ type: "notfound" });
    }
    expect(await route(s.store, "builder.example", "/admin")).toEqual({ type: "next" });
  });
});

describe("網址與 cookie", () => {
  it("siteBase／siteUrl：自有網域 → 子網域 → /s/<slug>；本機帶 port", () => {
    const t = { slug: "lin-bakery", primary_domain: null };
    expect(siteBase(t, "https://builder.example")).toBe("https://builder.example/s/lin-bakery");
    process.env.PLATFORM_SITES_DOMAIN = "sites.example";
    expect(siteBase(t, "https://builder.example")).toBe("https://lin-bakery.sites.example");
    expect(siteUrl(t, "/orders/A?k=1", "https://builder.example")).toBe("https://lin-bakery.sites.example/orders/A?k=1");
    expect(siteBase(t, "http://localhost:3250")).toBe("http://lin-bakery.sites.example:3250");
    expect(siteBase({ ...t, primary_domain: "shop.lin.tw" }, "https://builder.example")).toBe("https://shop.lin.tw");
  });

  it("會員 cookie：租戶 host 上 host-only（沒有 Domain）、path /；路徑模式 path /s/<slug>", () => {
    const tenant = { id: "11111111-2222-3333-4444-555555555555", slug: "lin-bakery" } as TenantRow;
    const hostReq = new Request("https://lin-bakery.sites.example/s/lin-bakery/api/account/login", { headers: { "x-gb-host-slug": "lin-bakery", "x-gb-origin": "https://lin-bakery.sites.example" } });
    const res = NextResponse.redirect("https://lin-bakery.sites.example/account", 303);
    setMemberCookie(res, tenant, "tok", new Date(Date.now() + 86400_000), hostReq);
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toMatch(/gbm_111111112222=tok/);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Path=\/s\//);
    expect(sc.toLowerCase()).not.toContain("domain=");
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=lax/i);
    const pathReq = new Request("https://builder.example/s/lin-bakery/api/account/login");
    const res2 = NextResponse.redirect("https://builder.example/s/lin-bakery/account", 303);
    setMemberCookie(res2, tenant, "tok", new Date(Date.now() + 86400_000), pathReq);
    expect(res2.headers.get("set-cookie")).toMatch(/Path=\/s\/lin-bakery/);
    // header 是別的租戶 → 不算 host 模式（不會把 cookie 開到 /）
    expect(siteCookiePath(new Headers({ "x-gb-host-slug": "other-shop", "x-gb-origin": "https://x" }), "lin-bakery")).toBe("/s/lin-bakery");
    const res3 = NextResponse.redirect("https://x/", 303);
    clearMemberCookie(res3, tenant, hostReq);
    expect(res3.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("預覽、canonical、publish 回傳網址都用正式網址", async () => {
    const s = await twoSites();
    process.env.PLATFORM_SITES_DOMAIN = "sites.example";
    const pv = await previewChanges(s.ctx, { site: "lin-bakery" });
    expect(pv.previewUrl).toMatch(/^http:\/\/lin-bakery\.sites\.example\/\?preview=/);
    const d = await addDomain(s.ctx, { site: "lin-bakery", domain: "www.lin.test" }, s.mock);
    await checkDomain(s.ctx, { site: "lin-bakery", domainId: d.id }, s.mock, mockTxtVerifier);
    await activateDomain(s.ctx, { site: "lin-bakery", domainId: d.id, confirm: true });
    expect((await previewChanges(s.ctx, { site: "lin-bakery" })).previewUrl).toMatch(/^http:\/\/www\.lin\.test\/\?preview=/);
    expect((await listDomains(s.ctx, { site: "lin-bakery" })).siteUrl).toBe("http://www.lin.test"); // ctx.baseUrl 是 http（本機）→ 同協定
  });
});

describe("自有網域服務（mock adapter，不打 Vercel）", () => {
  const actor = (role: "owner" | "editor" | "viewer", tenantId: string): Actor => ({ kind: "owner", label: `owner:${role}`, tenantId, scopes: TENANT_SCOPES, role });

  it("權限：只有平台後台與店主 owner 能新增／啟用／移除；editor、viewer、MCP token 一律拒絕", async () => {
    const s = await twoSites();
    const tok: Actor = { kind: "token", label: "t", tenantId: s.a.id, scopes: TENANT_SCOPES };
    for (const a of [actor("editor", s.a.id), actor("viewer", s.a.id), tok]) {
      await expect(addDomain({ ...s.ctx, actor: a }, { domain: "x.lin.test" }, s.mock)).rejects.toMatchObject({ code: "forbidden" });
    }
    const r = await addDomain({ ...s.ctx, actor: actor("owner", s.a.id) }, { domain: "x.lin.test" }, s.mock);
    expect(r.status).toBe("pending");
    // 跨租戶：A 的 owner 不能操作 B 的網站
    await expect(addDomain({ ...s.ctx, actor: actor("owner", s.a.id) }, { site: "other-shop", domain: "y.lin.test" }, s.mock)).rejects.toMatchObject({ code: "forbidden" });
    expect(s.mock.calls.every((c) => c.op === "add" || c.op === "check")).toBe(true);
  });

  it("輸入檢查：平台網域、平台子網域不能加；未驗證不能啟用；啟用需 confirm；移除會清掉正式網址", async () => {
    const s = await twoSites();
    process.env.PLATFORM_SITES_DOMAIN = "sites.example";
    await expect(addDomain(s.ctx, { site: "lin-bakery", domain: "lin-bakery.sites.example" }, s.mock)).rejects.toThrow(/平台/);
    await expect(addDomain(s.ctx, { site: "lin-bakery", domain: "localhost" }, s.mock)).rejects.toMatchObject({ code: "invalid" });
    await expect(addDomain(s.ctx, { site: "lin-bakery", domain: "bad domain" }, s.mock)).rejects.toMatchObject({ code: "invalid" });
    const r = await addDomain(s.ctx, { site: "lin-bakery", domain: "https://Shop.Lin.Example/path" }, s.mock);
    expect(r.domain).toBe("shop.lin.example");
    expect(r.dnsRecords.map((x) => x.type)).toEqual(["CNAME", "TXT", "TXT"]); // 指向＋Vercel 驗證＋Gather 專屬所有權 TXT
    s.mock.force.set("shop.lin.example", false);
    await expect(activateDomain(s.ctx, { site: "lin-bakery", domainId: r.id, confirm: true })).rejects.toThrow(/驗證中/);
    expect((await checkDomain(s.ctx, { site: "lin-bakery", domainId: r.id }, s.mock, mockTxtVerifier)).status).toBe("pending");
    s.mock.force.set("shop.lin.example", true);
    expect((await sweepPendingDomains(s.store, s.mock, 50, mockTxtVerifier)).verified).toBe(1);
    await expect(activateDomain(s.ctx, { site: "lin-bakery", domainId: r.id })).rejects.toMatchObject({ code: "confirm_required" });
    await activateDomain(s.ctx, { site: "lin-bakery", domainId: r.id, confirm: true });
    expect((await s.store.getTenantBySlug("lin-bakery"))!.primary_domain).toBe("shop.lin.example");
    await removeDomain(s.ctx, { site: "lin-bakery", domainId: r.id, confirm: true }, s.mock);
    expect((await s.store.getTenantBySlug("lin-bakery"))!.primary_domain).toBeNull();
    expect(s.mock.calls.filter((c) => c.op === "remove")).toEqual([{ op: "remove", domain: "shop.lin.example" }]);
  });

  it("沒有設定網域 API → 清楚說明，不會默默成功", async () => {
    const s = await twoSites();
    await expect(addDomain(s.ctx, { site: "lin-bakery", domain: "a.lin.test" }, null)).rejects.toThrow(/尚未設定網域 API/);
  });

  it("Vercel adapter：請求形狀正確（假 fetch，不連網）；apex 用 A、子網域用 CNAME", async () => {
    expect(isApex("lin.tw")).toBe(true);
    expect(isApex("lin.com.tw")).toBe(true);
    expect(isApex("shop.lin.com.tw")).toBe(false);
    expect(pointingRecords("lin.com.tw")).toEqual([{ type: "A", name: "@", value: "76.76.21.21", reason: "把網域指到 Vercel" }]);
    const seen: string[] = [];
    const a = createVercelDomainAdapter({ token: "test-token", projectId: "prj_test", teamId: "team_test" }, async (url, init) => {
      seen.push(`${init.method} ${url}`);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      if (url.includes("/config")) return new Response(JSON.stringify({ misconfigured: false }), { status: 200 });
      return new Response(JSON.stringify({ name: "shop.lin.tw", verified: true, verification: [] }), { status: 200 });
    });
    const r = await a.add("shop.lin.tw");
    expect(r).toMatchObject({ verified: true, configured: true });
    expect(seen).toEqual([
      "POST https://api.vercel.com/v10/projects/prj_test/domains?teamId=team_test",
      "GET https://api.vercel.com/v9/projects/prj_test/domains/shop.lin.tw?teamId=team_test",
      "GET https://api.vercel.com/v6/domains/shop.lin.tw/config?teamId=team_test",
    ]);
  });
});

describe("第九批審查 M1：自有網域不能被搶佔", () => {
  it("必須同時通過租戶專屬 TXT 與 Vercel 驗證；別的網站的 TXT 不算；冷卻期；pending 7 天過期釋放", async () => {
    const s = await twoSites();
    // B 先加了 A 的網域（搶佔），Vercel 也說 verified，但 B 拿不出 A 的 DNS 控制權 → 一直 pending
    const txtRecords = new Map<string, string>(); // 網域擁有者真正設定的 TXT
    const txt = async (name: string, expected: string) => txtRecords.get(name) === `gather-verify=${expected}`;
    const b = await addDomain(s.ctx, { site: "other-shop", domain: "shop.lin.test" }, s.mock);
    expect(b.dnsRecords.some((r) => r.type === "TXT" && r.name === "_gather-verify.shop.lin.test")).toBe(true);
    expect((await checkDomain(s.ctx, { site: "other-shop", domainId: b.id }, s.mock, txt)).status).toBe("pending");
    expect((await checkDomain(s.ctx, { site: "other-shop", domainId: b.id }, s.mock, txt)).lastError).toMatch(/_gather-verify/);
    // 7 天沒驗證 → 自動過期釋放
    const later = Date.now() + 8 * 86400_000;
    expect((await sweepPendingDomains(s.store, s.mock, 50, txt, later)).expired).toBe(1);
    expect(await s.store.getDomainByName("shop.lin.test")).toBeNull();
    // 過期釋放的 pending 網域沒有冷卻期（不讓搶佔者拿冷卻期卡住真正的擁有者）→ A 可以馬上加入並用自己的 TXT 驗證
    const a0 = await addDomain(s.ctx, { site: "lin-bakery", domain: "shop.lin.test" }, s.mock);
    const t0 = a0.dnsRecords.find((r) => r.name === "_gather-verify.shop.lin.test")!;
    expect(t0.value).not.toBe(b.dnsRecords.find((r) => r.name === "_gather-verify.shop.lin.test")!.value); // 每個網站的 token 不同
    txtRecords.set(t0.name, t0.value);
    expect((await checkDomain(s.ctx, { site: "lin-bakery", domainId: a0.id }, s.mock, txt)).status).toBe("verified");
    // 換一個網域示範正常流程：A 加入 → 設定自己的 TXT → 驗證成功
    const a = await addDomain(s.ctx, { site: "lin-bakery", domain: "www.lin.test" }, s.mock);
    const mine = a.dnsRecords.find((r) => r.name === "_gather-verify.www.lin.test")!;
    expect((await checkDomain(s.ctx, { site: "lin-bakery", domainId: a.id }, s.mock, txt)).status).toBe("pending");
    txtRecords.set(mine.name, mine.value);
    expect((await checkDomain(s.ctx, { site: "lin-bakery", domainId: a.id }, s.mock, txt)).status).toBe("verified");
    // 移除後 7 天內只有原租戶能加回
    await removeDomain(s.ctx, { site: "lin-bakery", domainId: a.id, confirm: true }, s.mock);
    await expect(addDomain(s.ctx, { site: "other-shop", domain: "www.lin.test" }, s.mock)).rejects.toThrow(/冷卻期/);
    await expect(addDomain(s.ctx, { site: "lin-bakery", domain: "www.lin.test" }, s.mock)).resolves.toMatchObject({ status: "pending" });
  });
});
