/**
 * 整合測試（npm run test:db）：第九批（2）店主帳號（migration 0039）在真 DB 上。
 * - email unique（小寫 check）、(tenant, user) unique；一次性 token 併發 5 次只成功 1 次；TOTP 時間步條件更新只成功一次。
 * - 邀請 → 接受 → 登入 → session 撤銷（真 DB）；跨租戶成員查不到。
 * 建 is_test 租戶與 itest 帳號，跑完刪除。🔴 不寄信（沒有 sendMail）。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { getOwnerSession, inviteOwnerInternal, ownerAcceptInvite, ownerLogin, ownerLogout } from "@/lib/services/owners";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const ts = Date.now().toString(36);
const slugA = `itown-a-${ts}`;
const slugB = `itown-b-${ts}`;
const email = `itown-${ts}@example.com`;

describe.skipIf(!enabled)("店主帳號（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };

  afterAll(async () => {
    if (!enabled) return;
    await db.from("builder_tenants").delete().in("slug", [slugA, slugB]);
    await db.from("builder_owner_users").delete().like("email", `%${ts}%`);
    expect((await db.from("builder_owner_users").select("id").like("email", `%${ts}%`)).data).toEqual([]);
  });

  it("約束、一次性 token（併發）、邀請→登入→撤銷、跨租戶", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug: slugA, name: slugA, test: true });
    await createSite(ctx, { slug: slugB, name: slugB, test: true });
    const ta = (await store.getTenantBySlug(slugA))!;
    const tb = (await store.getTenantBySlug(slugB))!;
    expect((await db.from("builder_owner_users").insert({ email: `UPPER-${ts}@example.com` })).error?.code).toBe("23514");
    const deps = { store, ipSecret: "itest-ip", baseUrl: "https://itest.example" };
    const inv = await inviteOwnerInternal(deps, ta, { email, role: "owner", by: "itest" });
    expect((await db.from("builder_owner_users").insert({ email })).error?.code).toBe("23505");
    expect((await db.from("builder_tenant_users").insert({ tenant_id: ta.id, user_id: inv.userId, role: "viewer", invited_by: "x" })).error?.code).toBe("23505");
    const raw = decodeURIComponent(inv.inviteUrl.split("t=")[1]!);
    // 一次性：同一個邀請連結併發 5 次只有 1 次成功
    const tokHash = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
    const nowIso = new Date().toISOString();
    const r = await Promise.all(Array.from({ length: 5 }, () => store.consumeOwnerToken(tokHash, "invite", nowIso)));
    expect(r.filter(Boolean)).toHaveLength(1);
    // 再發一次邀請來完成流程
    const inv2 = await inviteOwnerInternal(deps, ta, { email, role: "owner", by: "itest" });
    await ownerAcceptInvite(deps, { token: decodeURIComponent(inv2.inviteUrl.split("t=")[1]!), password: "itest-password-1", ip: "203.0.113.9" });
    const s = await ownerLogin(deps, { email, password: "itest-password-1", ip: "203.0.113.9" });
    if (s.kind !== "session") throw new Error("expected session");
    expect((await getOwnerSession(store, s.token))!.user.email).toBe(email);
    await ownerLogout(store, s.token);
    expect(await getOwnerSession(store, s.token)).toBeNull();
    // TOTP 時間步：併發 4 次同一步只成功 1 次
    const steps = await Promise.all(Array.from({ length: 4 }, () => store.claimTotpStep(inv.userId, 123456)));
    expect(steps.filter(Boolean)).toHaveLength(1);
    expect(await store.claimTotpStep(inv.userId, 123455)).toBe(false);
    // 跨租戶
    expect(await store.getTenantUser(tb.id, inv.userId)).toBeNull();
    expect((await store.getTenantUser(ta.id, inv.userId))!.status).toBe("active");
  });
});
