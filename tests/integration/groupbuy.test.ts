/**
 * 整合測試（npm run test:db）：第八批 group-buy 在真 DB 上的行為（migration 0035）。
 * - 限量併發不超賣（builder_place_group_buy_order：8 搶 3 只成立 3 單；sold ≤ quota 的 DB check）；取消釋放限量冪等。
 * - 銀行明細配對：一筆明細只配一單、一張單只被一筆配（partial unique）；確認＝單一交易（訂單不能收款就整筆回滾）。
 * - 分潤帳、通知紀錄只增不改（42501）；結團轉換只成功一次。
 * 建 is_test 租戶，跑完刪除。🔴 不呼叫任何金流 API、不寄信。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct } from "@/lib/services/shop";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import { createGroupBuy, inviteLeader, placeGroupBuyOrder } from "@/lib/services/groupbuy";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itgb-${ts}`;

describe.skipIf(!enabled)("group-buy（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "https://itest.example", previewSecret: "itest-secret-xxxx" };
  const deps = { store, baseUrl: "https://itest.example" };
  let gbId = "";
  let itemId = "";
  let tenantId = "";
  const orderIds: string[] = [];
  const contact = (n: number) => ({ name: `整合${n}`, email: `gb${n}-${ts}@example.com`, phone: "0912345678" });
  const shipping = { name: "整合", phone: "0912345678", address: "台中市" };

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建站＋團購（限量 3、庫存 10）", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["shop", "group-buy"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "GB" } });
    await publishSite(ctx, { site: slug, confirm: true });
    tenantId = (await store.getTenantBySlug(slug))!.id;
    const p = await createProduct(ctx, { site: slug, slug: "tea", name: "茶", price: 500, trackInventory: true, stock: 10, status: "published", confirm: true });
    const g = await createGroupBuy(ctx, { site: slug, slug: "tea-gb", title: "茶團", endsAt: new Date(Date.now() + 86400_000).toISOString(), items: [{ productId: p.id, price: 399, quota: 3 }], status: "published", confirm: true });
    gbId = g.id;
    itemId = g.items[0]!.id;
  });

  it("限量併發不超賣：8 人同時搶限量 3 → 只成立 3 單；團購價 399；sold 不會超過 quota（DB check）", async () => {
    const t = (await store.getTenantById(tenantId))!;
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, n) => placeGroupBuyOrder(deps, { tenant: t, member: null, slug: "tea-gb", data: { items: [{ itemId, qty: 1 }], contact: contact(n), shipping, paymentMethod: "offline" } })));
    const ok = r.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof placeGroupBuyOrder>>> => x.status === "fulfilled");
    expect(ok).toHaveLength(3);
    for (const x of ok) {
      expect(x.value.order.items[0]!.unit_price).toBe(399);
      orderIds.push(x.value.order.id);
    }
    expect(r.filter((x) => x.status === "rejected").every((x) => /團購數量已達上限/.test(String((x as PromiseRejectedResult).reason?.message)))).toBe(true);
    const it = (await store.listGroupBuyItems(tenantId, gbId))[0]!;
    expect(it.sold).toBe(3);
    const o = (await db.from("builder_orders").select("group_buy_id").eq("id", orderIds[0]!).single()).data!;
    expect(o.group_buy_id).toBe(gbId);
    const bad = await db.from("builder_group_buy_items").update({ sold: 4 }).eq("id", itemId);
    expect(bad.error?.code).toBe("23514");
    expect((await store.getProductById(tenantId, it.product_id))!.stock).toBe(7);
  });

  it("取消釋放限量與庫存（同一交易、冪等）", async () => {
    const t = (await store.getTenantById(tenantId))!;
    const o = (await store.getOrderById(tenantId, orderIds[2]!))!;
    await cancelOrder(ctx, { site: slug, orderNo: o.order_no, confirm: true });
    expect((await store.cancelOrder(tenantId, o.id, ["pending_payment", "paid"], "again")).transitioned).toBe(false);
    expect((await store.listGroupBuyItems(tenantId, gbId))[0]!.sold).toBe(2);
    expect((await db.from("builder_group_buy_orders").select("quota_released_at").eq("order_id", o.id).single()).data!.quota_released_at).toBeTruthy();
    void t;
  });

  it("銀行明細：一筆明細只配一單、一張單只被一筆配（DB partial unique）；確認是單一交易，訂單不能收款整筆回滾", async () => {
    const imp = await store.insertBankImport({ tenant_id: tenantId, filename: "it.csv", row_count: 2, created_by: "itest" });
    const lines = await store.insertBankLines([
      { tenant_id: tenantId, import_id: imp.id, txn_date: "2026-10-19", amount: 399, last5: "11111", memo: null, fingerprint: `fp1-${ts}` },
      { tenant_id: tenantId, import_id: imp.id, txn_date: "2026-10-19", amount: 399, last5: "22222", memo: null, fingerprint: `fp2-${ts}` },
      { tenant_id: tenantId, import_id: imp.id, txn_date: "2026-10-19", amount: 399, last5: "22222", memo: null, fingerprint: `fp2-${ts}` },
    ]);
    expect(lines).toHaveLength(2); // 重複 fingerprint 略過
    const [l1, l2] = lines;
    const m1 = await store.insertBankMatch({ tenant_id: tenantId, line_id: l1!.id, order_id: orderIds[0]! });
    expect(m1).not.toBeNull();
    expect(await store.insertBankMatch({ tenant_id: tenantId, line_id: l1!.id, order_id: orderIds[1]! })).toBeNull();
    // 兩筆明細同時搶同一張單 → 只有一筆成立
    const race = await Promise.all([store.insertBankMatch({ tenant_id: tenantId, line_id: l2!.id, order_id: orderIds[1]! }), store.insertBankMatch({ tenant_id: tenantId, line_id: l2!.id, order_id: orderIds[1]! })]);
    expect(race.filter(Boolean)).toHaveLength(1);
    // 確認 m1 → 訂單已付款、明細 confirmed（同一交易）
    const paid = await store.confirmBankMatch(tenantId, m1!.id, "itest");
    expect(paid?.status).toBe("paid");
    expect((await store.listBankLines(tenantId, { ids: [l1!.id], limit: 1 }))[0]!.status).toBe("confirmed");
    expect(await store.confirmBankMatch(tenantId, m1!.id, "itest")).toBeNull(); // 已確認，不再處理
    // 訂單已取消 → confirm 整筆回滾，配對維持 suggested
    const m2 = race.find(Boolean)!;
    const o2 = (await store.getOrderById(tenantId, orderIds[1]!))!;
    await cancelOrder(ctx, { site: slug, orderNo: o2.order_no, confirm: true });
    await expect(store.confirmBankMatch(tenantId, m2.id, "itest")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.listBankMatches(tenantId, { ids: [m2.id], limit: 1 }))[0]!.status).toBe("suggested");
    expect((await store.getOrderById(tenantId, orderIds[1]!))!.status).toBe("cancelled");
  });

  it("團主分潤帳與結團通知只增不改（42501）；分潤付款記一筆、取消沖回", async () => {
    const t = (await store.getTenantById(tenantId))!;
    const lead = await inviteLeader(ctx, { site: slug, groupBuyId: gbId, name: "團主", email: `lead-${ts}@example.com`, commissionPercent: 10 });
    const r = await placeGroupBuyOrder(deps, { tenant: t, member: null, slug: "tea-gb", data: { items: [{ itemId, qty: 1 }], contact: contact(20), shipping, paymentMethod: "offline", leaderCode: lead.code } });
    await markOrderPaid(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    expect((await store.listGroupBuyCommissions(tenantId, { orderIds: [r.order.id] })).map((c) => c.amount)).toEqual([39]);
    await cancelOrder(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    expect((await store.listGroupBuyCommissions(tenantId, { orderIds: [r.order.id] })).map((c) => c.amount)).toEqual([39, -39]);
    const up = await db.from("builder_group_buy_commissions").update({ amount: 9999 }).eq("tenant_id", tenantId);
    expect(up.error?.code).toBe("42501");
    const del = await db.from("builder_group_buy_commissions").delete().eq("tenant_id", tenantId);
    expect(del.error?.code).toBe("42501");
    expect(await store.insertGroupBuyNotice({ tenant_id: tenantId, group_buy_id: gbId, order_id: r.order.id, kind: "formed" })).toBe(true);
    expect(await store.insertGroupBuyNotice({ tenant_id: tenantId, group_buy_id: gbId, order_id: r.order.id, kind: "formed" })).toBe(false);
    expect((await db.from("builder_group_buy_notices").delete().eq("tenant_id", tenantId)).error?.code).toBe("42501");
  });

  it("結團轉換只成功一次（併發 4 次）", async () => {
    const r = await Promise.all(Array.from({ length: 4 }, () => store.transitionGroupBuy(tenantId, gbId, ["published"], "closed", { closed_at: new Date().toISOString() })));
    expect(r.filter(Boolean)).toHaveLength(1);
    const t = (await store.getTenantById(tenantId))!;
    await expect(placeGroupBuyOrder(deps, { tenant: t, member: null, slug: "tea-gb", data: { items: [{ itemId, qty: 1 }], contact: contact(30), shipping, paymentMethod: "offline" } })).rejects.toThrow(/截止/);
    expect(await store.markGroupBuySettled(tenantId, gbId)).toBe(true);
    expect(await store.markGroupBuySettled(tenantId, gbId)).toBe(false);
  });
});
