/**
 * 第九批（3）：/build 計價、平台訂單、平台 PChomePay（假的 fetch）、付款權威確認才開站、冪等開站、sandbox 只開 is_test、加購、月費續約與停站。
 * 記憶體 Store。🔴 不打任何真實金流 API、不寄信（sendMail 收進陣列）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { enableModule } from "@/lib/services/modules";
import { quoteBuild } from "@/lib/platform/pricing";
import { clearPchomepayTokenCache } from "@/lib/pay/pchomepay";
import {
  buildTestToken,
  createAddonOrder,
  createBuildOrder,
  getPlatformOrderStatus,
  handlePlatformNotify,
  setRenewal,
  slugAvailability,
  startPlatformCheckout,
  sweepPlatformBilling,
  requestRenewalOrder,
  verifyBuildTestToken,
  monthlyFor,
  type PlatformDeps,
} from "@/lib/services/platform-billing";
import { ownerActor } from "@/lib/services/owners";
import type { Store } from "@/lib/store/types";

const ENV = ["PLATFORM_PCHOMEPAY_APP_ID", "PLATFORM_PCHOMEPAY_SECRET", "PLATFORM_PCHOMEPAY_SANDBOX"] as const;
beforeEach(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.PLATFORM_PCHOMEPAY_APP_ID = "TESTAPPID";
  process.env.PLATFORM_PCHOMEPAY_SECRET = "test-secret-not-real";
  process.env.PLATFORM_PCHOMEPAY_SANDBOX = "true";
  clearPchomepayTokenCache();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

/** 假的 PChomePay：建單回付款網址；回查狀態由測試控制（預設 P 處理中） */
function fakePchome() {
  const st = { status: new Map<string, { status: string; amount?: number }>(), creates: 0, queries: 0, down: false, hosts: new Set<string>() };
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    st.hosts.add(u.host);
    if (st.down) throw new Error("network down");
    const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/v1/token") return j({ token: "tok", expired_timestamp: Math.floor(Date.now() / 1000) + 1800 });
    if (u.pathname === "/v1/payment" && init.method === "POST") {
      st.creates++;
      const b = JSON.parse(String(init.body)) as { order_id: string; amount: number };
      st.status.set(b.order_id, st.status.get(b.order_id) ?? { status: "P", amount: b.amount });
      return j({ payment_url: `https://sandbox-pay.pchomepay.com.tw/pay/${b.order_id}` });
    }
    const m = /^\/v1\/payment\/(.+)$/.exec(u.pathname);
    if (m) {
      st.queries++;
      const x = st.status.get(decodeURIComponent(m[1]!));
      return x ? j({ order_id: m[1], status: x.status, amount: x.amount }) : j({ error: "not found" }, 404);
    }
    throw new Error(`unexpected ${url}`);
  };
  return { st, fetchImpl };
}

function env(store: Store) {
  const pc = fakePchome();
  const sent: { to: string; subject: string; text: string }[] = [];
  const deps: PlatformDeps = { store, baseUrl: "https://builder.example", previewSecret: "test-preview-secret-xxxxxxxx", sendMail: async (to, subject, text) => void sent.push({ to, subject, text }), fetchImpl: pc.fetchImpl, gemini: null };
  const notify = (gw: string) => handlePlatformNotify(deps, new URLSearchParams({ notify_type: "order_confirm", notify_message: JSON.stringify({ order_id: gw }) }).toString());
  return { deps, pc, sent, notify };
}

const input = (slug: string, extra: Record<string, unknown> = {}) => ({ modules: ["shop", "contact-form"], brandName: "林家烘焙", slug, email: "boss@example.com", themePreset: "warm-terroir", ...extra });

describe("計價", () => {
  it("依賴自動帶入、必備 core＋sections-basic、首次付款＝建置費＋第一個月；加購只算沒有的", () => {
    const q = quoteBuild(["shop"]);
    expect(q.lines.map((l) => [l.id, l.autoAdded])).toEqual([["core", true], ["sections-basic", true], ["members", true], ["shop", false]]);
    expect(q.setupTotal).toBe(0 + 3000 + 8000 + 30000);
    expect(q.monthlyTotal).toBe(300 + 0 + 300 + 1500);
    expect(q.firstPayment).toBe(q.setupTotal + q.monthlyTotal);
    const add = quoteBuild(["coupons", "invoice"], { existing: ["core", "sections-basic", "members", "shop"], existingMonthly: 2100 });
    expect(add.lines.map((l) => l.id)).toEqual(["coupons", "invoice"]);
    expect(add.monthlyAfter).toBe(2100 + 300 + 500);
    expect(() => quoteBuild(["nope"])).toThrow(/未知模組/);
  });

  it("竄改價格無效：輸入 strict（多送 price／total 直接拒絕），金額一律 server 算", async () => {
    const store = newStore();
    const e = env(store);
    await expect(createBuildOrder(e.deps, { ...input("lin-a"), total: 1 }, { by: "t", allowSandbox: true })).rejects.toMatchObject({ code: "invalid" });
    await expect(createBuildOrder(e.deps, { ...input("lin-a"), prices: { shop: 1 } }, { by: "t", allowSandbox: true })).rejects.toMatchObject({ code: "invalid" });
    const r = await createBuildOrder(e.deps, input("lin-a"), { by: "t", allowSandbox: true });
    expect(r.order.amount_total).toBe(quoteBuild(["shop", "contact-form"]).firstPayment);
  });
});

describe("網址代號與建單", () => {
  it("代號衝突：已存在的網站、保留字、進行中的訂單；格式錯誤", async () => {
    const store = newStore();
    const e = env(store);
    await createSite(ctxFor(store), { slug: "taken-site", name: "x" });
    expect(await slugAvailability(store, "taken-site")).toMatchObject({ available: false, reason: /已被使用/ });
    expect(await slugAvailability(store, "admin")).toMatchObject({ available: false });
    expect(await slugAvailability(store, "A")).toMatchObject({ available: false });
    await createBuildOrder(e.deps, input("lin-b"), { by: "t", allowSandbox: true });
    expect(await slugAvailability(store, "lin-b")).toMatchObject({ available: false, reason: /其他訂單/ });
    await expect(createBuildOrder(e.deps, input("lin-b", { email: "x@example.com" }), { by: "t", allowSandbox: true })).rejects.toMatchObject({ code: "conflict" });
    await expect(createBuildOrder(e.deps, input("taken-site"), { by: "t", allowSandbox: true })).rejects.toMatchObject({ code: "conflict" });
    // 併發搶同一個代號：只成立一張
    const rs = await Promise.allSettled([1, 2, 3, 4].map((i) => createBuildOrder(e.deps, input("lin-race", { email: `r${i}@example.com` }), { by: "t", allowSandbox: true })));
    expect(rs.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("平台金流沒設定 → 不能建單（尚未開放付款）；sandbox 金鑰沒有測試許可 → 拒絕；測試簽章驗證", async () => {
    const store = newStore();
    const e = env(store);
    await expect(createBuildOrder(e.deps, input("lin-c"), { by: "t", allowSandbox: false })).rejects.toMatchObject({ code: "forbidden" });
    delete process.env.PLATFORM_PCHOMEPAY_APP_ID;
    await expect(createBuildOrder(e.deps, input("lin-c"), { by: "t", allowSandbox: true })).rejects.toThrow(/尚未開放線上付款/);
    const tok = buildTestToken("s1");
    expect(verifyBuildTestToken("s1", tok)).toBe(true);
    expect(verifyBuildTestToken("s2", tok)).toBe(false);
    expect(verifyBuildTestToken("s1", tok, Date.now() + 2 * 3600_000)).toBe(false);
  });
});

describe("付款權威確認才開站", () => {
  it("偽造 notify（回查未付）不開站；金額不符不開站；回查已付才開站：is_test、模組、版型、首頁草稿、店主邀請、月費；重複 notify 只開一站", async () => {
    const store = newStore();
    const e = env(store);
    const r = await createBuildOrder(e.deps, input("lin-pay"), { by: "t", allowSandbox: true });
    expect(r.order).toMatchObject({ sandbox: true, is_test: true, status: "pending_payment" });
    const co = await startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
    expect(co.paymentUrl).toMatch(/^https:\/\/sandbox-pay/);
    expect([...e.pc.st.hosts]).toEqual(["sandbox-api.pchomepay.com.tw"]); // 🔴 sandbox 訂單只打 sandbox
    expect((await startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey })).reused).toBe(true);
    await expect(startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: "wrong-key-wrong-key-xx" })).rejects.toMatchObject({ code: "not_found" });
    const gw = (await store.getPlatformOrderByNo(r.order.order_no))!.gateway_order_no!;
    // 1. 偽造：有人直接打 notify，但金流回查是處理中 → 不開站
    expect((await e.notify(gw)).outcome).toBe("pending");
    expect(await store.getTenantBySlug("lin-pay")).toBeNull();
    // 2. 回查已付但金額不符 → 不標記
    e.pc.st.status.set(gw, { status: "S", amount: 1 });
    expect((await e.notify(gw)).outcome).toBe("amount_mismatch");
    expect((await store.getPlatformOrderByNo(r.order.order_no))!.status).toBe("pending_payment");
    // 3. 回查已付、金額相符 → 開站（重複 notify 5 次併發只開一站）
    e.pc.st.status.set(gw, { status: "S", amount: r.order.amount_total });
    const outs = await Promise.all(Array.from({ length: 5 }, () => e.notify(gw)));
    expect(outs.filter((o) => o.outcome === "paid")).toHaveLength(1);
    expect(outs.every((o) => o.status === 200)).toBe(true);
    const tenants = (await store.listTenants()).filter((t) => t.slug === "lin-pay");
    expect(tenants).toHaveLength(1);
    const t = tenants[0]!;
    expect(t).toMatchObject({ is_test: true, name: "林家烘焙" });
    const mods = (await store.listTenantModules(t.id)).map((m) => m.module_id).sort();
    expect(mods).toEqual(["contact-form", "core", "members", "sections-basic", "shop"]);
    const draft = (await store.getDraft(t.id))!.content;
    expect(draft.theme).toMatchObject({ preset: "warm-terroir" });
    expect(draft.pages[0]!.sections.map((s) => s.type)).toEqual(["hero", "rich_text", "features", "contact_form"]);
    expect(t.published_revision_id).toBeNull(); // 首頁是草稿，店主確認後才發布
    expect((await store.getTenantBilling(t.id))!).toMatchObject({ monthly_amount: r.order.amount_monthly, is_test: true });
    const user = (await store.getOwnerUserByEmail("boss@example.com"))!;
    expect((await store.getTenantUser(t.id, user.id))!).toMatchObject({ role: "owner", status: "invited" });
    expect(e.sent.filter((m) => m.subject.includes("邀請你管理網站"))).toHaveLength(1);
    expect(e.sent.filter((m) => m.subject.includes("已開好"))).toHaveLength(1);
    // 沒有發任何 MCP token（引導 OAuth／後台發行）
    expect(await store.listTokens(t.id)).toEqual([]);
    const st = await getPlatformOrderStatus(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
    expect(st).toMatchObject({ status: "paid", provisionState: "done", ownerUrl: "https://builder.example/owner/t/lin-pay" });
  });

  it("開站時代號已被占用 → paid_needs_attention＋警示＋通知付款人；cron 重試不會多建", async () => {
    const store = newStore();
    const e = env(store);
    const r = await createBuildOrder(e.deps, input("lin-fail"), { by: "t", allowSandbox: true });
    await startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
    const gw = (await store.getPlatformOrderByNo(r.order.order_no))!.gateway_order_no!;
    await createSite(ctxFor(store), { slug: "lin-fail", name: "搶先的人" });
    e.pc.st.status.set(gw, { status: "S", amount: r.order.amount_total });
    // 第九批審查 M2：重試也不會成功 → paid_needs_attention、notify 回 200（不讓金流無限重送）、警示平台＋寄信給付款人
    expect(await e.notify(gw)).toMatchObject({ status: 200, outcome: "paid_needs_attention" });
    const o = (await store.getPlatformOrderByNo(r.order.order_no))!;
    expect(o).toMatchObject({ status: "paid_needs_attention", provision_state: "failed" });
    expect(o.provision_error).toMatch(/網址代號/);
    expect(e.sent.some((m) => m.subject.includes("平台訂單需要處理"))).toBe(true);
    expect(e.sent.some((m) => m.to === "boss@example.com" && m.subject.includes("已收到你的付款"))).toBe(true);
    expect((await e.notify(gw)).status).toBe(200);
    await sweepPlatformBilling(e.deps);
    expect((await store.listTenants()).filter((t) => t.slug === "lin-fail")).toHaveLength(1);
  });

  it("回查環境必須等於建單環境：sandbox 訂單在切成正式金鑰後回查 → 要求重送、不開站", async () => {
    const store = newStore();
    const e = env(store);
    const r = await createBuildOrder(e.deps, input("lin-env"), { by: "t", allowSandbox: true });
    await startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
    const gw = (await store.getPlatformOrderByNo(r.order.order_no))!.gateway_order_no!;
    e.pc.st.status.set(gw, { status: "S", amount: r.order.amount_total });
    process.env.PLATFORM_PCHOMEPAY_SANDBOX = "false";
    expect(await e.notify(gw)).toMatchObject({ status: 500, outcome: "query_failed" });
    expect(await store.getTenantBySlug("lin-env")).toBeNull();
  });

  it("逾期前先回查：已付 → 開站（不標逾期）；未付 → 標 expired；回查失敗 → 先不動", async () => {
    const store = newStore();
    const e = env(store);
    const mk = async (slug: string) => {
      const r = await createBuildOrder(e.deps, input(slug), { by: "t", allowSandbox: true });
      await startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
      return (await store.getPlatformOrderByNo(r.order.order_no))!;
    };
    const paid = await mk("lin-exp-a");
    const unpaid = await mk("lin-exp-b");
    const down = await mk("lin-exp-c");
    e.pc.st.status.set(paid.gateway_order_no!, { status: "S", amount: paid.amount_total });
    e.pc.st.status.set(unpaid.gateway_order_no!, { status: "F" });
    e.pc.st.status.delete(down.gateway_order_no!); // 404 → 回查失敗
    const later = Date.now() + 3 * 3600_000;
    await sweepPlatformBilling(e.deps, later);
    expect((await store.getPlatformOrderById(paid.id))!).toMatchObject({ status: "paid", provision_state: "done" });
    expect((await store.getPlatformOrderById(unpaid.id))!.status).toBe("expired");
    expect((await store.getPlatformOrderById(down.id))!.status).toBe("pending_payment");
  });
});

describe("加購與月費", () => {
  async function paidSite(store: Store, slug: string) {
    const e = env(store);
    const r = await createBuildOrder(e.deps, input(slug, { modules: ["contact-form"] }), { by: "t", allowSandbox: true });
    await startPlatformCheckout(e.deps, { orderNo: r.order.order_no, accessKey: r.accessKey });
    const gw = (await store.getPlatformOrderByNo(r.order.order_no))!.gateway_order_no!;
    e.pc.st.status.set(gw, { status: "S", amount: r.order.amount_total });
    await e.notify(gw);
    const t = (await store.getTenantBySlug(slug))!;
    const user = (await store.getOwnerUserByEmail("boss@example.com"))!;
    const m = (await store.getTenantUser(t.id, user.id))!;
    await store.updateTenantUser(t.id, m.id, { status: "active" });
    return { e, t, order: r.order, ctx: { ...ctxFor(store), baseUrl: "https://builder.example", actor: ownerActor(user, m) } };
  }

  it("付費模組要先購買（店主不能直接 enable_module）；加購付款後自動開通、月費只加一次（重複 notify 冪等）", async () => {
    const store = newStore();
    const s = await paidSite(store, "lin-addon");
    await expect(enableModule(s.ctx, { moduleId: "blog" })).rejects.toThrow(/需要先購買/);
    const before = (await store.getTenantBilling(s.t.id))!.monthly_amount;
    const a = await createAddonOrder(s.ctx, { modules: ["blog", "core"] });
    expect(a.quote.lines.map((l) => l.id)).toEqual(["blog"]);
    const k = new URL(a.statusUrl).searchParams.get("k")!;
    await startPlatformCheckout(s.e.deps, { orderNo: a.orderNo, accessKey: k });
    const gw = (await store.getPlatformOrderByNo(a.orderNo))!.gateway_order_no!;
    s.e.pc.st.status.set(gw, { status: "S", amount: a.quote.firstPayment });
    await Promise.all([s.e.notify(gw), s.e.notify(gw), s.e.notify(gw)]);
    expect((await store.listTenantModules(s.t.id)).find((m) => m.module_id === "blog")?.status).not.toBe("disabled");
    expect((await store.getTenantBilling(s.t.id))!.monthly_amount).toBe(before + 200);
    await expect(createAddonOrder(s.ctx, { modules: ["blog"] })).rejects.toThrow(/都已經開通/);
    // 第九批審查 L11：月費＝已購模組集合重算（不是累加）
    const bb = (await store.getTenantBilling(s.t.id))!;
    expect(bb.monthly_amount).toBe(monthlyFor(bb.modules));
    // 重疊的待付款加購單 → 拒絕
    await createAddonOrder(s.ctx, { modules: ["newsletter"] });
    await expect(createAddonOrder(s.ctx, { modules: ["newsletter", "search"] })).rejects.toThrow(/待付款加購單/);
    await expect(createAddonOrder(s.ctx, { modules: ["search"] })).resolves.toBeTruthy();
    // 平台後台不受付費限制
    await expect(enableModule(ctxFor(store), { site: "lin-addon", moduleId: "ai-chat" })).resolves.toBeTruthy();
  });

  it("續約：到期前 7 天建續費單並寄帳單（同一期只一張）；過期進寬限；寬限結束停站（不刪資料）；付款後恢復", async () => {
    const store = newStore();
    const s = await paidSite(store, "lin-renew");
    const b = (await store.getTenantBilling(s.t.id))!;
    const due = Date.parse(b.paid_until);
    const r1 = await sweepPlatformBilling(s.e.deps, due - 3 * 86400_000);
    const r2 = await sweepPlatformBilling(s.e.deps, due - 2 * 86400_000);
    expect(r1.renewals).toBe(1);
    expect(r2.renewals).toBe(0);
    const renewals = await store.listPlatformOrders({ tenantId: s.t.id, kind: "renewal", limit: 10 });
    expect(renewals).toHaveLength(1);
    expect(s.e.sent.filter((m) => m.subject.includes("月費帳單"))).toHaveLength(1);
    await sweepPlatformBilling(s.e.deps, due + 86400_000);
    expect((await store.getTenantBilling(s.t.id))!.status).toBe("past_due");
    expect((await store.getTenantById(s.t.id))!.status).not.toBe("suspended");
    await sweepPlatformBilling(s.e.deps, due + 8 * 86400_000);
    expect((await store.getTenantBilling(s.t.id))!.status).toBe("suspended");
    expect((await store.getTenantById(s.t.id))!.status).toBe("suspended");
    expect(await store.getDraft(s.t.id)).not.toBeNull(); // 資料保留
    // 停站後店主到後台「付月費」→ 新的一期從現在開始 → 付款 → 恢復
    expect((await store.getPlatformOrderById(renewals[0]!.id))!.status).toBe("expired");
    const link = await requestRenewalOrder(s.ctx, {});
    const u = new URL(link.statusUrl);
    const ro = (await store.getPlatformOrderByNo(decodeURIComponent(u.pathname.split("/").pop()!)))!;
    const k = u.searchParams.get("k")!;
    await startPlatformCheckout(s.e.deps, { orderNo: ro.order_no, accessKey: k });
    const gw = (await store.getPlatformOrderById(ro.id))!.gateway_order_no!;
    s.e.pc.st.status.set(gw, { status: "S", amount: ro.amount_total });
    expect((await s.e.notify(gw)).outcome).toBe("paid");
    expect((await store.getTenantById(s.t.id))!.status).not.toBe("suspended");
    expect((await store.getTenantBilling(s.t.id))!).toMatchObject({ status: "active", paid_until: ro.period_end });
  });

  it("停止續費需 confirm；到期後停站；editor 不能停", async () => {
    const store = newStore();
    const s = await paidSite(store, "lin-cancel");
    await expect(setRenewal(s.ctx, { cancel: true })).rejects.toMatchObject({ code: "confirm_required" });
    await setRenewal(s.ctx, { cancel: true, confirm: true });
    const b = (await store.getTenantBilling(s.t.id))!;
    expect((await sweepPlatformBilling(s.e.deps, Date.parse(b.paid_until) - 86400_000)).renewals).toBe(0);
    await sweepPlatformBilling(s.e.deps, Date.parse(b.paid_until) + 1000);
    expect((await store.getTenantById(s.t.id))!.status).toBe("suspended");
    const editor = { ...s.ctx, actor: { ...s.ctx.actor, role: "editor" as const } };
    await expect(setRenewal(editor, { cancel: false })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("第九批審查 M2：逾期後才付款", () => {
  it("逾期單之後才付款、代號已被新單占用 → paid_needs_attention（notify 200、警示、通知付款人）；sweep 會回查逾期但有付款的單；處理中（P）不釋放代號", async () => {
    const store = newStore();
    const e = env(store);
    const a = await createBuildOrder(e.deps, input("lin-late"), { by: "t", allowSandbox: true });
    await startPlatformCheckout(e.deps, { orderNo: a.order.order_no, accessKey: a.accessKey });
    const gwA = (await store.getPlatformOrderByNo(a.order.order_no))!.gateway_order_no!;
    // 過期了、但回查是處理中（P）→ 不釋放代號，別人不能搶
    await store.updatePlatformOrder(a.order.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    e.pc.st.status.set(gwA, { status: "P", amount: a.order.amount_total });
    await expect(createBuildOrder(e.deps, input("lin-late", { email: "b@example.com" }), { by: "t", allowSandbox: true })).rejects.toMatchObject({ code: "conflict" });
    // 回查失敗 → 標 expired；新的人拿到代號
    e.pc.st.status.set(gwA, { status: "F" });
    const b = await createBuildOrder(e.deps, input("lin-late", { email: "b@example.com" }), { by: "t", allowSandbox: true });
    expect((await store.getPlatformOrderById(a.order.id))!.status).toBe("expired");
    // A 其實後來付款成功了（金流回查變 S）→ sweep 回查逾期單 → 撞代號 → paid_needs_attention
    e.pc.st.status.set(gwA, { status: "S", amount: a.order.amount_total });
    const r = await sweepPlatformBilling(e.deps);
    expect(r.settled).toBe(1);
    expect((await store.getPlatformOrderById(a.order.id))!).toMatchObject({ status: "paid_needs_attention", paid_amount: a.order.amount_total });
    expect((await store.getPlatformOrderById(b.order.id))!.status).toBe("pending_payment");
    expect(e.sent.filter((m) => m.subject.includes("平台訂單需要處理"))).toHaveLength(1);
    expect(e.sent.some((m) => m.to === "boss@example.com" && m.text.includes("已被使用"))).toBe(true);
    // 之後的 notify 都回 200（不無限重送）、不重複警示
    expect(await e.notify(gwA)).toMatchObject({ status: 200 });
    expect(e.sent.filter((m) => m.subject.includes("平台訂單需要處理"))).toHaveLength(1);
  });
});

