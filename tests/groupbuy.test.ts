/**
 * 第八批：group-buy（團購）。記憶體 Store。
 * 團購價由 server 計、限量不超賣、取消釋放限量、成團門檻（未達自動取消、冪等）、團主分潤（基數＝商品淨額、取消沖回、不能自己分自己）、
 * 團主報表遮罩且只看得到自己、複製團購、銀行明細配對（唯一、多重候選不自動配、確認才標已付款、CSV injection）、出貨匯出防 injection＋個資紀錄、租戶隔離。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { createCoupon } from "@/lib/services/coupons";
import { cancelOrder, markOrderPaid } from "@/lib/services/orders";
import {
  closeGroupBuy,
  confirmBankMatches,
  createGroupBuy,
  duplicateGroupBuy,
  exportShipping,
  getGroupBuy,
  importBankStatement,
  inviteLeader,
  leaderReport,
  parseBankCsv,
  placeGroupBuyOrder,
  settleGroupBuy,
  suggestBankMatches,
  sweepGroupBuys,
  updateGroupBuy,
} from "@/lib/services/groupbuy";
import { commissionFor } from "@/lib/services/groupbuy-hooks";
import { issueToken } from "@/lib/services/tokens";
import { authenticateBearer } from "@/lib/tokens";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

const contact = (n: number) => ({ name: `王小${n}明`, email: `buyer${n}@example.com`, phone: "0912345678" });
const shipping = { name: "王小明", phone: "0912345678", address: "台北市中正區八德路一段 1 號" };
const future = (days = 3) => new Date(Date.now() + days * 86400_000).toISOString();

async function gbShop(store: Store, slug: string, opts: { quota?: number | null; minQty?: number | null } = {}) {
  const shop = await makeShop(store, slug);
  await enableModule(shop.ctx, { site: slug, moduleId: "group-buy", config: {} });
  const sent: { to: string; subject: string; body: string }[] = [];
  const ctx = { ...shop.ctx, sendMail: async (to: string, subject: string, body: string) => void sent.push({ to, subject, body }) };
  const g = await createGroupBuy(ctx, {
    site: slug,
    slug: "autumn",
    title: "秋季團購",
    endsAt: future(),
    minQty: opts.minQty ?? null,
    pickupPoints: [{ id: "huashan", name: "小時光華山店", address: "台北市中正區八德路一段 1 號" }],
    items: [{ productId: shop.mug.id, price: 280, quota: opts.quota === undefined ? 2 : opts.quota }],
    status: "published",
    confirm: true,
  });
  const deps = { store, baseUrl: "http://test.local", sendMail: ctx.sendMail };
  const order = (n: number, extra: Record<string, unknown> = {}) =>
    placeGroupBuyOrder(deps, { tenant: shop.tenant, member: null, slug: "autumn", data: { items: [{ itemId: g.items[0]!.id, qty: 1 }], contact: contact(n), shipping, paymentMethod: "offline", ...extra } });
  return { ...shop, ctx, g, sent, deps, order };
}

describe("團購：計價與限量", () => {
  it("團購價由 server 依團購品項計算；前端多送的欄位（價格）一律拒絕；不在團購裡的品項拒絕", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-price");
    const r = await s.order(1);
    expect(r.order.items[0]!.unit_price).toBe(280);
    expect(r.order.subtotal).toBe(280);
    expect(r.order.group_buy_id).toBe(s.g.id);
    await expect(s.order(2, { items: [{ itemId: s.g.items[0]!.id, qty: 1, price: 1 }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(s.order(2, { total: 1 })).rejects.toMatchObject({ code: "invalid" });
    await expect(s.order(2, { items: [{ itemId: "not-an-item", qty: 1 }] })).rejects.toThrow(/不在這個團購/);
  });

  it("限量 2：併發 5 單只成立 2 單；取消釋放限量（冪等）後可再下", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-quota");
    const r = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => s.order(n)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    const err = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(err.reason.message)).toMatch(/團購數量已達上限/);
    expect((await store.listGroupBuyItems(s.tenant.id, s.g.id))[0]!.sold).toBe(2);
    const ok = r.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof s.order>>>;
    await cancelOrder(s.ctx, { site: "gb-quota", orderNo: ok.value.order.order_no, confirm: true });
    expect(await store.cancelOrder(s.tenant.id, ok.value.order.id, ["pending_payment"], "x")).toMatchObject({ transitioned: false });
    expect(await store.releaseOrderStock(s.tenant.id, ok.value.order.id)).toBe(false);
    expect((await store.listGroupBuyItems(s.tenant.id, s.g.id))[0]!.sold).toBe(1);
    await expect(s.order(9)).resolves.toBeTruthy();
    await expect(s.order(10)).rejects.toThrow(/已達上限/);
  });

  it("到店自取：運費 0、取貨資訊是自取點；未開團／已截止拒絕", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-pickup", { quota: null });
    const r = await s.order(1, { pickupPointId: "huashan", shipping: undefined });
    expect(r.order.shipping_fee).toBe(0);
    expect(r.order.shipping_choice).toMatchObject({ type: "pickup", store: { name: "小時光華山店" } });
    await store.updateGroupBuy(s.tenant.id, s.g.id, { ends_at: new Date(Date.now() - 1000).toISOString() });
    await expect(s.order(2)).rejects.toThrow(/已截止/);
  });
});

describe("團購：成團門檻與結團", () => {
  it("未達門檻：截止自動結團 → 取消所有訂單（含已付款）、只通知一次；重跑冪等", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-fail", { quota: null, minQty: 5 });
    const a = await s.order(1);
    const b = await s.order(2);
    await markOrderPaid(s.ctx, { site: "gb-fail", orderNo: b.order.order_no, confirm: true });
    await store.updateGroupBuy(s.tenant.id, s.g.id, { ends_at: new Date(Date.now() - 1000).toISOString() });
    const g0 = (await store.getGroupBuy(s.tenant.id, s.g.id))!;
    const after = await settleGroupBuy(s.deps, s.tenant, g0);
    expect(after).toMatchObject({ status: "failed" });
    expect(after.settled_at).toBeTruthy();
    for (const o of [a.order, b.order]) expect((await store.getOrderById(s.tenant.id, o.id))!).toMatchObject({ status: "cancelled", cancel_reason: "group_buy_failed" });
    const failMails = () => s.sent.filter((m) => m.subject.includes("未成團")).length;
    expect(failMails()).toBe(3); // 兩位客人＋店主
    await settleGroupBuy(s.deps, s.tenant, after);
    await sweepGroupBuys(s.deps);
    expect(failMails()).toBe(3);
    expect((await store.listGroupBuyItems(s.tenant.id, s.g.id))[0]!.sold).toBe(0);
  });

  it("達門檻：close_group_buy 需 confirm → 成團、通知一次、之後不能下單", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-ok", { quota: null, minQty: 2 });
    await s.order(1);
    await s.order(2);
    await expect(closeGroupBuy(s.ctx, { site: "gb-ok", groupBuyId: s.g.id })).rejects.toMatchObject({ code: "confirm_required" });
    const r = await closeGroupBuy(s.ctx, { site: "gb-ok", groupBuyId: s.g.id, confirm: true });
    expect(r.status).toBe("closed");
    expect(s.sent.filter((m) => m.subject.includes("團購成團")).length).toBe(2);
    await sweepGroupBuys(s.deps);
    expect(s.sent.filter((m) => m.subject.includes("團購成團")).length).toBe(2);
    await expect(s.order(3)).rejects.toThrow(/已截止/);
  });
});

describe("團主分潤與報表", () => {
  it("分潤基數＝扣掉折扣後的商品實付；付款才記、取消沖回（只增不改、各一次）；自己買自己的團不分潤", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-kol", { quota: null });
    await enableModule(s.ctx, { site: "gb-kol", moduleId: "coupons", config: {} });
    await createCoupon(s.ctx, { site: "gb-kol", code: "GB50", kind: "fixed", value: 50 });
    const lead = await inviteLeader(s.ctx, { site: "gb-kol", groupBuyId: s.g.id, name: "阿美", email: "Leader@Example.com", commissionPercent: 10 });
    expect(lead.shareUrl).toContain(`?leader=${lead.code}`);
    const o = await s.order(1, { leaderCode: lead.code, couponCode: "GB50", items: [{ itemId: s.g.items[0]!.id, qty: 2 }] });
    expect(o.order.group_buy_leader_id).toBe(lead.leaderId);
    expect((await store.listGroupBuyCommissions(s.tenant.id, { orderIds: [o.order.id] })).length).toBe(0); // 未付款不記
    await markOrderPaid(s.ctx, { site: "gb-kol", orderNo: o.order.order_no, confirm: true });
    const c = await store.listGroupBuyCommissions(s.tenant.id, { orderIds: [o.order.id] });
    expect(c).toMatchObject([{ kind: "earn", base: 560 - 50, amount: Math.floor((560 - 50) * 0.1) }]);
    await cancelOrder(s.ctx, { site: "gb-kol", orderNo: o.order.order_no, confirm: true });
    const c2 = await store.listGroupBuyCommissions(s.tenant.id, { orderIds: [o.order.id] });
    expect(c2.map((x) => x.amount)).toEqual([51, -51]);
    expect(await store.insertGroupBuyCommission({ ...c2[0]!, id: undefined } as never)).toBe(false);
    // 團主自己下單：不記團主
    const self = await s.order(5, { leaderCode: lead.code, contact: { name: "阿美", email: "leader+x@example.com", phone: "0911111111" } });
    expect(self.order.group_buy_leader_id).toBeNull();
    // 無效團主碼（未指派）被忽略
    const other = await inviteLeader(s.ctx, { site: "gb-kol", name: "路人", email: "x@example.com" });
    expect((await s.order(6, { leaderCode: other.code })).order.group_buy_leader_id).toBeNull();
    expect(commissionFor(1000, "fixed", 80)).toBe(80);
    expect(commissionFor(50, "fixed", 80)).toBe(50);
  });

  it("團主報表：簽章連結、買家姓名遮罩、不含 email／電話／地址、只看得到自己的訂單；換版後舊連結失效", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-report", { quota: null });
    const a = await inviteLeader(s.ctx, { site: "gb-report", groupBuyId: s.g.id, name: "A", email: "a@example.com", commissionPercent: 10 });
    const b = await inviteLeader(s.ctx, { site: "gb-report", groupBuyId: s.g.id, name: "B", email: "b@example.com", commissionFixed: 30 });
    const oa = await s.order(1, { leaderCode: a.code });
    await s.order(2, { leaderCode: b.code });
    await markOrderPaid(s.ctx, { site: "gb-report", orderNo: oa.order.order_no, confirm: true });
    const t = new URL(a.reportUrl).searchParams;
    const r = (await leaderReport(store, s.tenant, t.get("l"), t.get("t")))!;
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ orderNo: oa.order.order_no, buyer: "王＊＊明", commission: 28 });
    const text = JSON.stringify(r);
    for (const pii of ["buyer1@example.com", "0912345678", "八德路"]) expect(text).not.toContain(pii);
    expect(r.totals).toMatchObject({ orders: 1, commission: 28 });
    expect(await leaderReport(store, s.tenant, t.get("l"), "x".repeat(32))).toBeNull();
    expect(await leaderReport(store, s.tenant, b.leaderId, t.get("t"))).toBeNull();
    await inviteLeader(s.ctx, { site: "gb-report", name: "A", email: "a@example.com", rotateReportLink: true });
    expect(await leaderReport(store, s.tenant, t.get("l"), t.get("t"))).toBeNull();
  });
});

describe("複製團購", () => {
  it("一鍵複製為草稿：品項、團購價、限量、團主分潤帶過去，已售歸零", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-dup");
    await inviteLeader(s.ctx, { site: "gb-dup", groupBuyId: s.g.id, name: "A", email: "a@example.com", commissionPercent: 8 });
    await s.order(1);
    const d = await duplicateGroupBuy(s.ctx, { site: "gb-dup", groupBuyId: s.g.id });
    expect(d).toMatchObject({ slug: "autumn-2", status: "draft", items: [{ price: 280, quota: 2, sold: 0 }] });
    const g = await getGroupBuy(s.ctx, { site: "gb-dup", groupBuyId: d.id });
    expect(g.leaders).toMatchObject([{ name: "A", commission: "8%" }]);
    await expect(updateGroupBuy(s.ctx, { site: "gb-dup", groupBuyId: d.id, patch: { status: "published" } })).rejects.toMatchObject({ code: "confirm_required" });
    expect((await updateGroupBuy(s.ctx, { site: "gb-dup", groupBuyId: d.id, patch: { status: "published" }, confirm: true })).status).toBe("published");
  });
});

describe("銀行明細對帳", () => {
  it("CSV：格式驗證、CSV injection（= + - @ Tab 與全形）整份拒絕", () => {
    expect(parseBankCsv("日期,金額,帳號末五碼,備註\n2026-10-19,\"1,280\",12345678901,王小明\n")).toEqual([{ txnDate: "2026-10-19", amount: 1280, last5: "78901", memo: "王小明" }]);
    for (const bad of ["=SUM(A1)", "+886", "-100", "@cmd", "\tx", "＝1+1", " =1"]) {
      expect(() => parseBankCsv(`日期,金額,帳號末五碼,備註\n2026-10-19,100,12345,${bad.includes(",") ? `"${bad}"` : bad}\n`), bad).toThrow(/不能以/);
    }
    expect(() => parseBankCsv("日期,金額\n2026-02-30,100\n")).toThrow(/日期/);
    expect(() => parseBankCsv("日期,金額\n2026-10-19,abc\n")).toThrow(/金額/);
    expect(() => parseBankCsv("金額\n100\n")).toThrow(/標題列/);
  });

  it("配對純函式：唯一才建議、多重候選不自動配、時間窗外不配、備註含訂單編號也算", () => {
    const orders = [
      { id: "o1", order_no: "GB-20261019-0001", total: 280, created_at: "2026-10-19T02:00:00Z", payer_last5: "11111" },
      { id: "o2", order_no: "GB-20261019-0002", total: 280, created_at: "2026-10-19T03:00:00Z", payer_last5: "22222" },
      { id: "o3", order_no: "GB-20261019-0003", total: 560, created_at: "2026-10-19T03:00:00Z", payer_last5: "33333" },
      { id: "o4", order_no: "GB-20261019-0004", total: 560, created_at: "2026-10-19T04:00:00Z", payer_last5: "33333" },
    ];
    const r = suggestBankMatches(
      [
        { id: "l1", txn_date: "2026-10-20", amount: 280, last5: "11111", memo: null },
        { id: "l2", txn_date: "2026-10-20", amount: 560, last5: "33333", memo: null },
        { id: "l3", txn_date: "2026-11-30", amount: 280, last5: "22222", memo: null },
        { id: "l4", txn_date: "2026-10-19", amount: 280, last5: null, memo: "訂單 gb-20261019-0002" },
      ],
      orders,
      7,
    );
    expect(r.suggested).toEqual([
      { lineId: "l1", orderId: "o1" },
      { lineId: "l4", orderId: "o2" },
    ]);
    expect(r.ambiguous).toEqual([{ lineId: "l2", orderIds: ["o3", "o4"] }]);
    expect(r.unmatched).toEqual(["l3"]);
    // 兩筆明細搶同一張單 → 都不自動配
    const t = suggestBankMatches([{ id: "a", txn_date: "2026-10-20", amount: 280, last5: "11111", memo: null }, { id: "b", txn_date: "2026-10-21", amount: 280, last5: "11111", memo: null }], orders, 7);
    expect(t.suggested).toEqual([]);
    expect(t.ambiguous).toHaveLength(2);
  });

  it("匯入只產生建議（訂單不變）；確認才標已付款並寄信；重複匯入不重複；一筆明細只配一張單；已取消的單確認失敗並轉拒絕", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-bank", { quota: null });
    const a = await s.order(1, { payerLast5: "11111" });
    const b = await s.order(2, { payerLast5: "22222" });
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const csv = `日期,金額,帳號末五碼,備註\n${today},${a.order.total},00011111,\n${today},${b.order.total},22222,\n${today},999,55555,不相干\n`;
    const r = await importBankStatement(s.ctx, { site: "gb-bank", csv });
    expect(r).toMatchObject({ rows: 3, inserted: 3, unmatched: 1 });
    expect(r.suggestions.map((x) => x.orderNo).sort()).toEqual([a.order.order_no, b.order.order_no].sort());
    expect(JSON.stringify(r.suggestions)).not.toContain("buyer1@example.com");
    for (const o of [a.order, b.order]) expect((await store.getOrderById(s.tenant.id, o.id))!.status).toBe("pending_payment");
    expect((await importBankStatement(s.ctx, { site: "gb-bank", csv })).inserted).toBe(0);
    // 同一筆明細不能再配第二張單（DB 唯一約束語意）
    const line = (await store.listBankLines(s.tenant.id, { status: ["suggested"], limit: 10 }))[0]!;
    expect(await store.insertBankMatch({ tenant_id: s.tenant.id, line_id: line.id, order_id: b.order.id })).toBeNull();
    const ma = r.suggestions.find((x) => x.orderNo === a.order.order_no)!.matchId;
    const mb = r.suggestions.find((x) => x.orderNo === b.order.order_no)!.matchId;
    await expect(confirmBankMatches(s.ctx, { site: "gb-bank", matchIds: [ma] })).rejects.toMatchObject({ code: "confirm_required" });
    expect((await store.getOrderById(s.tenant.id, a.order.id))!.status).toBe("pending_payment");
    await cancelOrder(s.ctx, { site: "gb-bank", orderNo: b.order.order_no, confirm: true });
    const c = await confirmBankMatches(s.ctx, { site: "gb-bank", matchIds: [ma, mb], confirm: true });
    expect(c.results.find((x) => x.matchId === ma)).toMatchObject({ ok: true });
    expect(c.results.find((x) => x.matchId === mb)).toMatchObject({ ok: false });
    expect((await store.getOrderById(s.tenant.id, a.order.id))!.status).toBe("paid");
    expect(s.sent.some((m) => m.subject.includes(`付款成功 ${a.order.order_no}`))).toBe(true);
    expect((await store.listBankMatches(s.tenant.id, { ids: [mb], limit: 1 }))[0]!.status).toBe("rejected");
    const again = await confirmBankMatches(s.ctx, { site: "gb-bank", matchIds: [ma], confirm: true });
    expect(again.results[0]).toMatchObject({ ok: false });
  });
});

describe("出貨匯出與隔離", () => {
  it("出貨 CSV 防 injection、只含已付款、匯出寫個資紀錄", async () => {
    const store = newStore();
    const s = await gbShop(store, "gb-export", { quota: null });
    const evil = await s.order(1, { shipping: { name: "=HYPERLINK(\"http://x\")", phone: "0912345678", address: "+886 台北" } });
    await s.order(2);
    await markOrderPaid(s.ctx, { site: "gb-export", orderNo: evil.order.order_no, confirm: true });
    const r = await exportShipping(s.ctx, { site: "gb-export", groupBuyId: s.g.id, reason: "出貨" });
    expect(r.rows).toBe(1);
    expect(r.csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(r.csv).toContain(`"'+886 台北"`);
    expect(r.csv.startsWith("﻿")).toBe(true);
    const log = await store.listPiiLog(s.tenant.id, 10);
    expect(log[0]).toMatchObject({ action: "export", subject_type: "group_buy_shipping", subject_id: s.g.id, detail: { rows: 1, reason: "出貨" } });
  });

  it("租戶隔離：A 站的 token 看不到 B 站團購；同 slug 在不同站互不影響", async () => {
    const store = newStore();
    const a = await gbShop(store, "gb-iso-a");
    const b = await gbShop(store, "gb-iso-b");
    const tok = await issueToken(ctxFor(store), { site: "gb-iso-a", name: "a", scopes: ["site:read", "orders:read"] });
    const actor = (await authenticateBearer(store, `Bearer ${tok.token}`))!;
    const actx = { ...ctxFor(store), actor };
    await expect(getGroupBuy(actx, { site: "gb-iso-b", groupBuyId: b.g.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(getGroupBuy(actx, { groupBuyId: b.g.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await getGroupBuy(actx, { groupBuyId: a.g.id })).id).toBe(a.g.id);
    await expect(exportShipping(actx, { groupBuyId: b.g.id })).rejects.toMatchObject({ code: "not_found" });
  });
});
