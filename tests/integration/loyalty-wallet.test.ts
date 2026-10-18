/**
 * 整合測試（npm run test:db）：第五批（loyalty／stored-value）在真 DB 上的原子性與只增不改。
 * 建 is_test 租戶，跑完刪除。🔴 不寄信、不呼叫任何金流 API。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule, enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct, placeOrder } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import { adjustPoints, onLoyaltyOrderPaid } from "@/lib/services/loyalty";
import { buyTopup, createTopupPlan, onWalletOrderPaid } from "@/lib/services/wallet";
import { computeLedgerState } from "@/lib/loyalty/ledger";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";
import type { MemberRow } from "@/lib/store/types";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itlw-${ts}`;
const D = 86400_000;

describe.skipIf(!enabled)("第五批 Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };
  const deps = { store, baseUrl: "http://itest" };
  let member: MemberRow;
  let productId = "";
  const contact = { name: "整合會員", email: `lw-${ts}@example.com`, phone: "0912345678" };
  const shipping = { name: "整合會員", phone: "0912345678", address: "台中市" };
  const buy = (extra: Record<string, unknown> = {}, qty = 1) =>
    placeOrder(deps, { tenant: { ...tenantCache! }, member, data: { items: [{ productId, qty }], contact, shipping, paymentMethod: "offline", ...extra } });
  let tenantCache: Awaited<ReturnType<typeof store.getTenantBySlug>> = null;

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試網站（shop＋loyalty，is_test）", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["shop"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "LW", shippingFee: 0 } });
    await enableModule(ctx, { site: slug, moduleId: "loyalty", config: { maxRedeemPercent: 100 } });
    await enableModule(ctx, { site: slug, moduleId: "stored-value", config: {} });
    await publishSite(ctx, { site: slug, confirm: true });
    tenantCache = await store.getTenantBySlug(slug);
    const p = await createProduct(ctx, { site: slug, slug: "item", name: "商品", price: 500, trackInventory: false, status: "published", confirm: true });
    productId = p.id;
    member = (await store.insertMember({ tenant_id: tenantCache!.id, email: contact.email, password_hash: "x", name: contact.name, phone: null }))!;
  });

  it("點數帳本只增不改：update／delete → 42501", async () => {
    await adjustPoints(ctx, { site: slug, memberId: member.id, amount: 300, reason: "整合測試", confirm: true });
    const up = await db.from("builder_points_ledger").update({ amount: 999999 }).eq("tenant_id", tenantCache!.id);
    expect(up.error?.code).toBe("42501");
    const del = await db.from("builder_points_ledger").delete().eq("tenant_id", tenantCache!.id);
    expect(del.error?.code).toBe("42501");
    expect((await store.creditState("points", tenantCache!.id, member.id)).balance).toBe(300);
  });

  it("折抵併發：可用 300 點、8 張訂單各用 100 點 → 只成立 3 張，其餘整筆回滾", async () => {
    const before = (await store.listOrders(tenantCache!.id, { limit: 1, offset: 0 })).total;
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => buy({ pointsToUse: 100 })));
    const ok = r.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(3);
    for (const f of r.filter((x) => x.status === "rejected")) expect(String((f as PromiseRejectedResult).reason.message)).toMatch(/點數不足/);
    expect((await store.listOrders(tenantCache!.id, { limit: 1, offset: 0 })).total).toBe(before + 3);
    expect(await store.creditState("points", tenantCache!.id, member.id)).toMatchObject({ balance: 0, available: 0 });
    // 取消其中一張 → 退回 100 點；冪等（再跑一次釋放函式也不會多退）
    const first = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof buy>>>).value.order;
    await cancelOrder(ctx, { site: slug, orderNo: first.order_no, confirm: true });
    await db.rpc("builder_release_order_credits", { p_tenant: tenantCache!.id, p_order: first.id });
    expect((await store.creditState("points", tenantCache!.id, member.id)).balance).toBe(100);
  });

  it("賺點冪等＋SQL 狀態與 TS 純函式一致（FIFO 到期）", async () => {
    const { order } = await buy({}, 2); // 1000 → 10 點
    await markOrderPaid(ctx, { site: slug, orderNo: order.order_no, confirm: true });
    const paid = (await store.getOrderById(tenantCache!.id, order.id))!;
    await onLoyaltyOrderPaid(deps, tenantCache!, paid);
    await onLoyaltyOrderPaid(deps, tenantCache!, paid);
    const earns = (await store.listCreditLedger("points", tenantCache!.id, member.id, 50)).filter((l) => l.kind === "earn");
    expect(earns).toHaveLength(1);
    expect(earns[0]!.amount).toBe(10);
    // 另一位會員：一批已到期（50）、一批未到期（20）——測試用直接 insert（帳本允許 insert）→ SQL 與 TS 同結果
    const m2 = (await store.insertMember({ tenant_id: tenantCache!.id, email: `lw2-${ts}@example.com`, password_hash: "x", name: "二號", phone: null }))!;
    await db.from("builder_points_ledger").insert([
      { tenant_id: tenantCache!.id, member_id: m2.id, kind: "adjust", amount: 50, expires_at: new Date(Date.now() - D).toISOString(), reason: "已過期批次", actor: "itest" },
      { tenant_id: tenantCache!.id, member_id: m2.id, kind: "adjust", amount: 20, expires_at: new Date(Date.now() + 30 * D).toISOString(), reason: "未過期批次", actor: "itest" },
    ]);
    for (const who of [member.id, m2.id]) {
      const sql = await store.creditState("points", tenantCache!.id, who);
      const all = await store.allCreditEntries("points", tenantCache!.id, who);
      const tsState = computeLedgerState(all.map((e) => ({ ...e, seq: e.id })));
      expect(sql).toMatchObject({ balance: tsState.balance, available: tsState.available, expiredDue: tsState.expiredDue });
    }
    expect(await store.creditState("points", tenantCache!.id, m2.id)).toMatchObject({ balance: 70, available: 20, expiredDue: 50 });
    expect(await store.creditExpire("points", tenantCache!.id, m2.id)).toBe(50);
    expect(await store.creditExpire("points", tenantCache!.id, m2.id)).toBe(0);
    expect(await store.creditState("points", tenantCache!.id, m2.id)).toMatchObject({ balance: 20, available: 20, expiredDue: 0 });
  });

  it("儲值：付款成功才入帳（hook 冪等）；帳本 update／delete → 42501", async () => {
    const plan = await createTopupPlan(ctx, { site: slug, name: "儲 1000 送 100", payAmount: 1000, bonusAmount: 100, bonusExpireDays: 30, status: "published", confirm: true });
    const r = await buyTopup(deps, { tenant: tenantCache!, member, data: { planId: plan.id, contact: { name: contact.name, phone: contact.phone }, paymentMethod: "offline" } });
    expect((await store.creditState("wallet", tenantCache!.id, member.id)).balance).toBe(0);
    await markOrderPaid(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    const paid = (await store.getOrderById(tenantCache!.id, r.order.id))!;
    await onWalletOrderPaid(deps, tenantCache!, paid);
    expect(await store.creditState("wallet", tenantCache!.id, member.id)).toMatchObject({ balance: 1100, available: 1100 });
    const up = await db.from("builder_wallet_ledger").update({ amount: 1 }).eq("tenant_id", tenantCache!.id);
    expect(up.error?.code).toBe("42501");
    const del = await db.from("builder_wallet_ledger").delete().eq("tenant_id", tenantCache!.id);
    expect(del.error?.code).toBe("42501");
  });

  it("儲值金支付併發：可用 1100、8 張訂單各付 400 → 只成立 2 張；取消退回冪等", async () => {
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => buy({ walletToUse: 400 })));
    const ok = r.filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(2);
    for (const f of r.filter((x) => x.status === "rejected")) expect(String((f as PromiseRejectedResult).reason.message)).toMatch(/餘額不足/);
    expect((await store.creditState("wallet", tenantCache!.id, member.id)).available).toBe(300);
    const first = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof buy>>>).value.order;
    expect(first).toMatchObject({ wallet_paid: 400, total: 100 });
    await cancelOrder(ctx, { site: slug, orderNo: first.order_no, confirm: true });
    await db.rpc("builder_release_order_credits", { p_tenant: tenantCache!.id, p_order: first.id });
    expect((await store.creditState("wallet", tenantCache!.id, member.id)).available).toBe(700);
  });
});
