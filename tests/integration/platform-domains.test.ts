/**
 * 整合測試（npm run test:db）：第九批（1）自有網域（migration 0038）在真 DB 上。
 * - 同一網域只能屬於一個租戶（unique）；每個租戶只有一個 active（partial unique）；builder_activate_domain 單一交易寫 primary_domain。
 * - 只有 active 網域會被路由查詢對應到租戶（pending／verified 不生效）。
 * - anon 讀不到 builder_tenant_domains（RLS 開、無 policy）。
 * 建 is_test 租戶，跑完刪除。🔴 不呼叫 Vercel API（mock adapter）。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { activateDomain, addDomain, checkDomain } from "@/lib/services/domains";
import { mockTxtVerifier, createMockDomainAdapter } from "@/lib/domains/adapter";
import { storeRoutingLookup } from "@/lib/domain-routing";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const ts = Date.now().toString(36);
const slugA = `itdom-a-${ts}`;
const slugB = `itdom-b-${ts}`;

describe.skipIf(!enabled)("自有網域（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    await db.from("builder_tenants").delete().in("slug", [slugA, slugB]);
    expect((await db.from("builder_tenants").select("id").in("slug", [slugA, slugB])).data).toEqual([]);
  });

  it("unique 網域、一個 active、activate 單一交易、只有 active 生效、anon 無權限", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug: slugA, name: slugA, test: true });
    await createSite(ctx, { slug: slugB, name: slugB, test: true });
    const mock = createMockDomainAdapter();
    const d1 = await addDomain(ctx, { site: slugA, domain: `a1-${ts}.test` }, mock);
    const d2 = await addDomain(ctx, { site: slugA, domain: `a2-${ts}.test` }, mock);
    await expect(addDomain(ctx, { site: slugB, domain: `a1-${ts}.test` }, mock)).rejects.toMatchObject({ code: "conflict" });
    const ta = (await store.getTenantBySlug(slugA))!;
    const tb = (await store.getTenantBySlug(slugB))!;
    // DB 層也擋：直接插同網域 → 23505
    expect((await db.from("builder_tenant_domains").insert({ tenant_id: tb.id, domain: `a1-${ts}.test`, created_by: "it", verify_token: "x" })).error?.code).toBe("23505");
    const lookup = storeRoutingLookup(store);
    expect(await lookup.byDomain(`a1-${ts}.test`)).toBeNull();
    await checkDomain(ctx, { site: slugA, domainId: d1.id }, mock, mockTxtVerifier);
    await checkDomain(ctx, { site: slugA, domainId: d2.id }, mock, mockTxtVerifier);
    expect(await lookup.byDomain(`a1-${ts}.test`)).toBeNull(); // verified 但未啟用
    await activateDomain(ctx, { site: slugA, domainId: d1.id, confirm: true });
    expect(await lookup.byDomain(`a1-${ts}.test`)).toEqual({ slug: slugA, primaryDomain: `a1-${ts}.test` });
    // 換成 d2：d1 自動降回 verified（partial unique：一個租戶只有一個 active）
    await activateDomain(ctx, { site: slugA, domainId: d2.id, confirm: true });
    const rows = (await db.from("builder_tenant_domains").select("domain,status").eq("tenant_id", ta.id).order("domain")).data!;
    expect(rows).toEqual([{ domain: `a1-${ts}.test`, status: "verified" }, { domain: `a2-${ts}.test`, status: "active" }]);
    expect((await store.getTenantById(ta.id))!.primary_domain).toBe(`a2-${ts}.test`);
    expect(await lookup.byDomain(`a1-${ts}.test`)).toBeNull();
    // 直接把第二筆改成 active → partial unique 擋下
    expect((await db.from("builder_tenant_domains").update({ status: "active" }).eq("tenant_id", ta.id).eq("domain", `a1-${ts}.test`)).error?.code).toBe("23505");
    // anon key（若有）讀不到
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (anonKey) {
      const anon = createClient(process.env.SUPABASE_URL!, anonKey, { auth: { persistSession: false } });
      const r = await anon.from("builder_tenant_domains").select("id").limit(1);
      expect(r.data ?? []).toEqual([]);
    }
    const priv = (await db.rpc("builder_activate_domain", { p_tenant: tb.id, p_domain_id: d1.id })).error;
    expect(priv?.message).toMatch(/domain not verified/);
  });
});
