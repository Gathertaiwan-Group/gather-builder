/**
 * 整合測試（npm run test:db）：第九批（3）平台訂單與自動開站（migration 0040）在真 DB 上。
 * - 🔴 重複 notify（併發 6 次）只開一個站：builder_tenants.platform_order_id unique＋claimPlatformProvision 樂觀鎖。
 * - 同一個網址代號只能有一張進行中的開站單（partial unique）；同一期續費單只一張。
 * - sandbox 訂單開出來的是 is_test 網站。
 * PChomePay 用假的 fetch（🔴 不打任何金流 API，金鑰是假值）。建 is_test 租戶與 itest 帳號，跑完刪除。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { clearPchomepayTokenCache } from "@/lib/pay/pchomepay";
import { createBuildOrder, handlePlatformNotify, startPlatformCheckout, type PlatformDeps } from "@/lib/services/platform-billing";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itbuild-${ts}`;
const email = `itbuild-${ts}@example.com`;

describe.skipIf(!enabled)("平台訂單與自動開站（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const saved = { a: process.env.PLATFORM_PCHOMEPAY_APP_ID, s: process.env.PLATFORM_PCHOMEPAY_SECRET, b: process.env.PLATFORM_PCHOMEPAY_SANDBOX };

  afterAll(async () => {
    if (!enabled) return;
    process.env.PLATFORM_PCHOMEPAY_APP_ID = saved.a;
    process.env.PLATFORM_PCHOMEPAY_SECRET = saved.s;
    process.env.PLATFORM_PCHOMEPAY_SANDBOX = saved.b;
    for (const k of ["PLATFORM_PCHOMEPAY_APP_ID", "PLATFORM_PCHOMEPAY_SECRET", "PLATFORM_PCHOMEPAY_SANDBOX"] as const) if (process.env[k] === undefined) delete process.env[k];
    await db.from("builder_tenants").delete().like("slug", `itbuild-%${ts}%`);
    await db.from("builder_platform_orders").delete().like("contact_email", `%${ts}%`);
    await db.from("builder_owner_users").delete().like("email", `%${ts}%`);
    expect((await db.from("builder_platform_orders").select("id").like("contact_email", `%${ts}%`)).data).toEqual([]);
  });

  it("重複 notify 只開一站（真 DB unique）、代號 partial unique、sandbox → is_test", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    process.env.PLATFORM_PCHOMEPAY_APP_ID = "ITESTFAKEAPP";
    process.env.PLATFORM_PCHOMEPAY_SECRET = "itest-fake-secret";
    process.env.PLATFORM_PCHOMEPAY_SANDBOX = "true";
    clearPchomepayTokenCache();
    const paid = new Map<string, number>();
    const fetchImpl = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (u.pathname === "/v1/token") return j({ token: "t", expired_timestamp: Math.floor(Date.now() / 1000) + 1800 });
      if (u.pathname === "/v1/payment" && init.method === "POST") return j({ payment_url: "https://sandbox-pay.example/x" });
      const id = decodeURIComponent(u.pathname.split("/").pop()!);
      return j(paid.has(id) ? { status: "S", amount: paid.get(id) } : { status: "P" });
    };
    const deps: PlatformDeps = { store, baseUrl: "https://itest.example", previewSecret: process.env.PREVIEW_SECRET!, fetchImpl, gemini: null };
    const r = await createBuildOrder(deps, { modules: ["contact-form"], brandName: "整合測試", slug, email }, { by: "itest", allowSandbox: true });
    // 同代號第二張進行中的單：DB partial unique 擋下
    const dup = await db.from("builder_platform_orders").insert({ order_no: `GP-20261019-${ts.slice(-6).toUpperCase().padStart(6, "Z")}`, kind: "new_site", slug, contact_email: email, amount_setup: 0, amount_monthly: 0, amount_total: 0, access_key_hash: "a".repeat(64), expires_at: new Date().toISOString(), created_by: "itest" });
    expect(dup.error?.code).toBe("23505");
    await startPlatformCheckout(deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
    const gw = (await store.getPlatformOrderByNo(r.order.order_no))!.gateway_order_no!;
    paid.set(gw, r.order.amount_total);
    const body = new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: gw }) }).toString();
    const outs = await Promise.all(Array.from({ length: 6 }, () => handlePlatformNotify(deps, body)));
    const afterNotify = await store.getPlatformOrderByNo(r.order.order_no);
    expect(outs.filter((o) => o.outcome === "paid"), JSON.stringify([outs.map((o) => o.outcome), afterNotify?.provision_error])).toHaveLength(1);
    const tenants = (await db.from("builder_tenants").select("id, is_test, platform_order_id").eq("slug", slug)).data!;
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({ is_test: true, platform_order_id: r.order.id });
    // DB 層：同一張平台訂單不能再掛到第二個租戶
    const second = await db.from("builder_tenants").insert({ slug: `itbuild-x-${ts}`, name: "x", status: "trial", theme: {}, settings: {}, is_test: true, platform_order_id: r.order.id });
    expect(second.error?.code).toBe("23505");
    const o = (await store.getPlatformOrderByNo(r.order.order_no))!;
    expect(o).toMatchObject({ status: "paid", provision_state: "done", tenant_id: tenants[0]!.id });
    expect((await db.from("builder_tenant_billing").select("is_test").eq("tenant_id", tenants[0]!.id).single()).data).toEqual({ is_test: true });
    // 續費單：同一期只能一張
    const ins = (start: string) => store.insertPlatformOrder({ order_no: `GP-20261019-${Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[^A-Z0-9]/g, "Z").padEnd(6, "Z")}`, kind: "renewal", tenant_id: tenants[0]!.id, slug: null, brand_name: "x", theme_preset: null, contact_email: email, modules: [], amount_setup: 0, amount_monthly: 300, amount_total: 300, period_start: start, period_end: start, sandbox: true, is_test: true, access_key_hash: "b".repeat(64), expires_at: new Date(Date.now() + 3600_000).toISOString(), created_by: "itest" });
    const start = new Date(Date.now() + 30 * 86400_000).toISOString();
    await ins(start);
    await expect(ins(start)).rejects.toMatchObject({ code: "conflict" });
  });
});
