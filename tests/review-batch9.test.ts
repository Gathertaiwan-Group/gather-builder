/**
 * 第九批獨立審查：L6（後台／OAuth 頁不能被嵌入）、L12（正式環境不把含 token 的信件內容寫進 log）。
 * 其他項目的測試：M1 tests/platform-urls.test.ts「第九批審查 M1」、M2 tests/platform-billing.test.ts「第九批審查 M2」＋整合測試、
 * M3／M4／L5／L13 tests/oauth.test.ts「第九批審查 OAuth」、L7–L10 tests/owners.test.ts、L11 tests/platform-billing.test.ts（加購）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { logUnsentMail } from "@/lib/mail";

const env = process.env as Record<string, string | undefined>;
afterEach(() => {
  vi.restoreAllMocks();
  env.NODE_ENV = "test";
  delete env.MAIL_LOG_BODIES;
});

describe("L6：frame-ancestors", () => {
  it("/oauth、/owner、/admin 回應帶 CSP frame-ancestors 'none' 與 X-Frame-Options DENY；租戶網站不受影響", async () => {
    process.env.APP_URL = "http://test.local";
    for (const p of ["/oauth/authorize", "/owner/login", "/admin/login", "/owner/t/x"]) {
      const r = await middleware(new NextRequest(`http://test.local${p}`));
      expect(r.headers.get("content-security-policy"), p).toBe("frame-ancestors 'none'");
      expect(r.headers.get("x-frame-options"), p).toBe("DENY");
    }
    const site = await middleware(new NextRequest("http://test.local/s/demo"));
    expect(site.headers.get("x-frame-options")).toBeNull();
  });
});

describe("L12：沒設 Resend 時的信件 log", () => {
  it("正式環境只記「未寄出」、不記內容（含連結）；本機才印內容", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    env.NODE_ENV = "production";
    logUnsentMail("owners", "boss@example.com", "邀請", "連結：https://x/owner/invite?t=gbi_SECRET");
    expect(spy.mock.calls.at(-1)![0]).not.toContain("gbi_SECRET");
    expect(spy.mock.calls.at(-1)![0]).toContain("未寄出");
    env.NODE_ENV = "development";
    logUnsentMail("owners", "boss@example.com", "邀請", "連結：https://x/owner/invite?t=gbi_SECRET");
    expect(spy.mock.calls.at(-1)![0]).toContain("gbi_SECRET");
  });
});
