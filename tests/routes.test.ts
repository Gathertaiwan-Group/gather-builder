import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { revokeToken } from "@/lib/services/tokens";
import { handleMcp } from "@/lib/mcp/handler";
import { handleAdminLogin } from "@/lib/adminLogin";
import { middleware } from "@/middleware";
import { ADMIN_COOKIE, createSessionValue } from "@/lib/adminAuth";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-xxxxxxxx";
  process.env.ADMIN_PASSWORD = "correct-horse";
  process.env.APP_URL = "http://test.local";
});

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
function mcpReq(token?: string, body: unknown = init, extra: Record<string, string> = {}) {
  return new Request("http://test.local/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
}

describe("MCP 路由認證", () => {
  it("無 token／錯 token／撤銷的 token → 401（第九批起帶 RFC 9728 resource_metadata）；有效的手動 token → 200（不觸發 OAuth）", async () => {
    const store = newStore();
    const admin = ctxFor(store);
    const site = await createSite(admin, { slug: "mcp-auth", name: "M" });

    const r0 = await handleMcp(mcpReq(), store);
    expect(r0.status).toBe(401);
    expect(r0.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="http:\/\/test\.local\/\.well-known\/oauth-protected-resource\/api\/mcp", scope="site:read /);
    const bad = await handleMcp(mcpReq("gbt_wrongwrongwrongwrongwrong"), store);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", resource_metadata=/);

    const ok = await handleMcp(mcpReq(site.token!), store);
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).toContain("gather-builder");

    const [row] = await store.listTokens("all");
    await revokeToken(admin, { tokenId: row!.id });
    expect((await handleMcp(mcpReq(site.token!), store)).status).toBe(401);
  });

  it("Origin 檢查：外站 Origin 403、沒帶 Origin 與 claude.ai 允許", async () => {
    const store = newStore();
    const site = await createSite(ctxFor(store), { slug: "mcp-origin", name: "M" });
    expect((await handleMcp(mcpReq(site.token!, init, { origin: "https://evil.example" }), store)).status).toBe(403);
    expect((await handleMcp(mcpReq(site.token!, init, { origin: "https://claude.ai" }), store)).status).toBe(200);
  });

  it("#8 內部錯誤不外洩細節（不含 SQL／約束名），只回通用訊息與追查碼", async () => {
    const base = newStore();
    const site = await createSite(ctxFor(base), { slug: "mcp-err", name: "M" });
    const broken: Store = {
      ...base,
      getDraft: async () => {
        throw new Error('getDraft: relation "builder_site_drafts" violates constraint builder_secret_idx');
      },
    };
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_site", arguments: {} } };
    const orig = console.error;
    console.error = () => undefined;
    const res = await handleMcp(mcpReq(site.token!, call), broken);
    console.error = orig;
    const text = JSON.stringify(await res.json());
    expect(text).toContain("追查碼");
    expect(text).not.toContain("builder_secret_idx");
    expect(text).not.toContain("relation");
  });
});

describe("middleware 擋後台", () => {
  it("未登入 /admin 導去登入、/api/admin 回 401；登入頁放行", async () => {
    const r1 = await middleware(new NextRequest("http://test.local/admin"));
    expect(r1.status).toBe(307);
    expect(r1.headers.get("location")).toContain("/admin/login");
    const r2 = await middleware(new NextRequest("http://test.local/api/admin/tokens", { method: "POST" }));
    expect(r2.status).toBe(401);
    const r3 = await middleware(new NextRequest("http://test.local/admin/login"));
    expect(r3.headers.get("x-middleware-next")).toBe("1");
  });
  it("有效 cookie 放行；竄改或過期 cookie 擋下；跨站 Origin 的 POST 403", async () => {
    const good = await createSessionValue(process.env.ADMIN_SESSION_SECRET!);
    const withCookie = (v: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
      new NextRequest("http://test.local/admin", { ...init, headers: { cookie: `${ADMIN_COOKIE}=${v}`, ...(init.headers ?? {}) } });
    expect((await middleware(withCookie(good))).headers.get("x-middleware-next")).toBe("1");
    expect((await middleware(withCookie(good.replace(/.$/, (c) => (c === "a" ? "b" : "a"))))).status).toBe(307);
    const expired = await createSessionValue(process.env.ADMIN_SESSION_SECRET!, Date.now() - 13 * 3600_000);
    expect((await middleware(withCookie(expired))).status).toBe(307);
    const csrf = await middleware(
      new NextRequest("http://test.local/api/admin/tokens", { method: "POST", headers: { cookie: `${ADMIN_COOKIE}=${good}`, origin: "https://evil.example" } }),
    );
    expect(csrf.status).toBe(403);
  });
});

describe("#6 後台登入限流（DB 計數，跨實例共用同一個 store）", () => {
  it("同 IP 10 次後，即使密碼正確也被擋；別的 IP 不受影響", async () => {
    const store = newStore();
    const login = (pw: string, ip = "9.9.9.9") =>
      handleAdminLogin(new Request("http://test.local/api/admin/login", { method: "POST", headers: { "x-forwarded-for": ip }, body: new URLSearchParams({ password: pw }) }), store);
    const ok = await login("correct-horse");
    expect(ok.headers.get("location")).toBe("http://test.local/admin");
    for (let i = 0; i < 9; i++) expect((await login("wrong")).headers.get("location")).toContain("err=");
    const blocked = await login("correct-horse");
    expect(decodeURIComponent(blocked.headers.get("location") ?? "")).toContain("嘗試太多次");
    expect((await login("correct-horse", "8.8.8.8")).headers.get("location")).toBe("http://test.local/admin");
  });
});
