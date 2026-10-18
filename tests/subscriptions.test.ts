/**
 * 第七批：subscriptions（藍新信用卡定期定額）。記憶體 Store＋真的藍新 provider 實作＋假的 fetch（官方格式、手冊範例金鑰）。
 * 狀態機、每期冪等入帳、扣款失敗→寬限→停權收回權益（冪等）、會員取消（終止委託，失敗可重試）、偽造的扣款通知被拒（解密＋回查）。
 * 🔴 不打任何真實 API。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { saveProviderAccount } from "@/lib/services/orders";
import { createCourse } from "@/lib/services/courses";
import { aesCbcDecryptHex, aesCbcEncryptHex } from "@/lib/pay/crypto";
import { createNewebpayProvider, newebpayCheckCode } from "@/lib/pay/newebpay";
import { payToken } from "@/lib/pay/notify-token";
import {
  SUBSCRIPTION_TRANSITIONS,
  cancelSubscription,
  canTransitionSubscription,
  createSubscriptionPlan,
  handleSubscriptionNotify,
  hasActiveSubscription,
  listSubscriptions,
  memberCancelSubscription,
  periodPlan,
  subscribe,
  sweepSubscriptions,
  type SubDeps,
} from "@/lib/services/subscriptions";
import type { FetchLike } from "@/lib/pay/types";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.APP_URL = "https://test.example";
  process.env.PAYMENT_ENC_KEY = Buffer.alloc(32, 6).toString("base64");
});

// 藍新定期定額手冊（NDNP）公開範例商店與金鑰（非真實商店）
const NW = { merchantId: "TEK1682407426", hashKey: "IaWudQJsuOT994cpHRWzv7Ge67yC1cE3", hashIv: "C1dLm3nxZRVlmBSP" };
const enc = (o: unknown, key = NW.hashKey) => aesCbcEncryptHex(JSON.stringify(o), key, NW.hashIv);
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const D = 86400_000;

function fakeNewebpay() {
  const st = { periodStatus: "1", already: 0, amt: 299, tradeStatus: "1" as string | null, terminate: "SUCCESS", terminates: 0, queryDown: false };
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    if (st.queryDown) throw new Error("network down");
    if (path === "/MPG/period/query") {
      const q = Object.fromEntries(new URLSearchParams(aesCbcDecryptHex(form.PostData_!, NW.hashKey, NW.hashIv)));
      return json({ Period: enc({ Status: "SUCCESS", Message: "", Result: { MerchantID: NW.merchantId, MerOrderNo: q.MerOrderNo, PeriodNo: q.PeriodNo, PeriodAmt: st.amt, Status: Number(st.periodStatus), TotalTimes: "12", AlreadyTimes: String(st.already) } }) });
    }
    if (path === "/API/QueryTradeInfo") {
      if (st.tradeStatus === null) return json({ Status: "TRA10021", Message: "查無", Result: [] });
      const r = { MerchantID: NW.merchantId, Amt: Number(form.Amt), TradeNo: "26101900000000009", MerchantOrderNo: form.MerchantOrderNo!, TradeStatus: st.tradeStatus };
      return json({ Status: "SUCCESS", Result: { ...r, CheckCode: newebpayCheckCode(r, NW.hashKey, NW.hashIv) } });
    }
    if (path === "/MPG/period/AlterStatus") {
      st.terminates++;
      if (st.terminate === "down") throw new Error("timeout");
      return json({ period: enc({ Status: st.terminate, Message: "", Result: { AlterType: "terminate" } }) });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { st, fetch };
}

async function subShop(store: Store, slug: string, opts: { sandbox?: boolean; trialDays?: number; course?: boolean } = {}) {
  const shop = await makeShop(store, slug);
  await enableModule(shop.ctx, { site: slug, moduleId: "subscriptions", config: { graceDays: 7 } });
  if (opts.course) await enableModule(shop.ctx, { site: slug, moduleId: "courses", config: {} });
  await saveProviderAccount(ctxFor(store), { site: slug, provider: "newebpay", appId: NW.merchantId, secrets: { hashKey: NW.hashKey, hashIv: NW.hashIv }, sandbox: !!opts.sandbox });
  await store.markPaymentAccount(shop.tenant.id, "newebpay", { status: "verified", verified_at: new Date().toISOString(), last_error: null });
  await publishSite(shop.ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  await store.upsertTenantModule({ ...(await store.listTenantModules(tenant.id)).find((m) => m.module_id === "subscriptions")!, status: "enabled" });
  const course = opts.course ? await createCourse(shop.ctx, { site: slug, slug: "vip", title: "VIP 課程", price: 1200, status: "published", confirm: true }) : null;
  const plan = await createSubscriptionPlan(shop.ctx, { site: slug, name: "月費會員", amount: 299, interval: "month", trialDays: opts.trialDays ?? 0, totalPeriods: 12, entitlement: course ? { kind: "course", courseId: course.id } : { kind: "none" }, status: "active", confirm: true });
  const member = (await store.insertMember({ tenant_id: tenant.id, email: "sub@example.com", password_hash: "x", name: "訂閱者", phone: null }))!;
  const nw = fakeNewebpay();
  const provider = createNewebpayProvider({ ...NW, test: !!opts.sandbox }, nw.fetch);
  const sent: { to: string; subject: string }[] = [];
  const deps: SubDeps = { store, baseUrl: "https://test.example", sendMail: async (to, subject) => void sent.push({ to, subject }), newebpayFor: async () => provider };
  const notify = (subId: string, payload: unknown, key?: string) =>
    handleSubscriptionNotify(deps, { tenantId: tenant.id, subscriptionId: subId, token: payToken("notify", `sub:${subId}`), rawBody: new URLSearchParams({ Period: enc(payload, key) }).toString(), contentType: "application/x-www-form-urlencoded" });
  return { ...shop, tenant, plan, member, course, nw, provider, deps, sent, notify };
}

const creation = (sub: { merchant_order_no: string }, extra: Record<string, unknown> = {}) => ({
  Status: "SUCCESS",
  Message: "委託單成立，且首次授權成功",
  Result: { MerchantID: NW.merchantId, MerchantOrderNo: sub.merchant_order_no, PeriodType: "M", PeriodAmt: "299", AuthTimes: 12, PeriodNo: "P2610190000aaaa", TradeNo: "26101900000000001", AuthCode: "123456", RespondCode: "00", ...extra },
});
const charge = (sub: { merchant_order_no: string }, n: number, ok = true, extra: Record<string, unknown> = {}) => ({
  Status: ok ? "SUCCESS" : "MPG03009",
  Message: ok ? "授權成功" : "授權失敗",
  Result: { RespondCode: ok ? "00" : "05", MerchantID: NW.merchantId, MerchantOrderNo: sub.merchant_order_no, OrderNo: `${sub.merchant_order_no}_${n}`, TradeNo: `2610190000000${n}`, TotalTimes: "12", AlreadyTimes: String(n), AuthAmt: 299, PeriodNo: "P2610190000aaaa", ...extra },
});

async function activeSub(s: Awaited<ReturnType<typeof subShop>>) {
  const r = await subscribe(s.deps, { tenant: s.tenant, member: s.member, data: { planId: s.plan.id } });
  s.nw.st.already = 1;
  const out = await s.notify(r.subscription.id, creation(r.subscription));
  return { sub: r.subscription, form: r.form, out };
}

describe("訂閱：狀態機", () => {
  it("只允許定義的轉換；cancelled／expired 是終點；store 條件式轉換", async () => {
    expect(canTransitionSubscription("pending", "active")).toBe(true);
    expect(canTransitionSubscription("active", "past_due")).toBe(true);
    expect(canTransitionSubscription("past_due", "active")).toBe(true);
    for (const [from, to] of [["pending", "past_due"], ["expired", "active"], ["cancelled", "active"], ["cancelled", "expired"], ["expired", "cancelled"]] as const) expect(canTransitionSubscription(from, to)).toBe(false);
    expect(SUBSCRIPTION_TRANSITIONS.cancelled).toEqual([]);
    const store = newStore();
    const s = await subShop(store, "sub-sm");
    const r = await subscribe(s.deps, { tenant: s.tenant, member: s.member, data: { planId: s.plan.id } });
    expect(await store.transitionSubscription(s.tenant.id, r.subscription.id, ["active"], "past_due")).toBeNull();
    // 同一會員同一方案同時只能一筆進行中
    await expect(subscribe(s.deps, { tenant: s.tenant, member: s.member, data: { planId: s.plan.id } })).rejects.toThrow(/已經有這個方案的訂閱/);
  });

  it("試用期／週期換算（藍新 PeriodType／PeriodPoint／StartType）", () => {
    const now = new Date("2026-10-19T02:00:00Z"); // 台北 10/19
    expect(periodPlan("month", 0, now)).toMatchObject({ periodType: "M", periodPoint: "19", startType: 2 });
    expect(periodPlan("month", 14, now)).toMatchObject({ periodType: "M", periodPoint: "02", startType: 1 });
    expect(periodPlan("year", 0, now)).toMatchObject({ periodType: "Y", periodPoint: "1019", startType: 2 });
  });
});

describe("訂閱：建立與每期扣款", () => {
  it("訂閱 → 藍新定期定額表單（PostData_ 解得開、參數正確）；未登入／sandbox 非預覽被拒", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-form");
    await expect(subscribe(s.deps, { tenant: s.tenant, member: null, data: { planId: s.plan.id } })).rejects.toMatchObject({ code: "unauthorized" });
    const r = await subscribe(s.deps, { tenant: s.tenant, member: s.member, data: { planId: s.plan.id } });
    expect(r.form.action).toBe("https://core.newebpay.com/MPG/period");
    const q = Object.fromEntries(new URLSearchParams(aesCbcDecryptHex(r.form.fields.PostData_!, NW.hashKey, NW.hashIv)));
    expect(q).toMatchObject({ Version: "1.5", MerOrderNo: r.subscription.merchant_order_no, PeriodAmt: "299", PeriodType: "M", PeriodStartType: "2", PeriodTimes: "12", PayerEmail: "sub@example.com" });
    expect(q.NotifyURL).toMatch(new RegExp(`/api/subscriptions/newebpay/notify/${s.tenant.id}\\?s=`));
    const sb = await subShop(store, "sub-sbx", { sandbox: true });
    await expect(subscribe(sb.deps, { tenant: sb.tenant, member: sb.member, data: { planId: sb.plan.id } })).rejects.toThrow(/無法線上訂閱/);
    await expect(subscribe(sb.deps, { tenant: sb.tenant, member: sb.member, allowSandbox: true, data: { planId: sb.plan.id } })).resolves.toBeTruthy();
  });

  it("建立成功（首期授權）→ active、第 1 期入帳、開通課程；重複通知冪等", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-create", { course: true });
    const { sub, out } = await activeSub(s);
    expect(out.outcome).toBe("charged:1");
    const row = (await store.getSubscription(s.tenant.id, sub.id))!;
    expect(row).toMatchObject({ status: "active", period_no: "P2610190000aaaa", entitlement_state: "granted" });
    expect((await store.getEnrollment(s.tenant.id, s.course!.id, s.member.id))!.status).toBe("active");
    expect((await s.notify(sub.id, creation(sub))).outcome).toMatch(/^already/);
    expect(await store.listSubscriptionCharges(s.tenant.id, sub.id)).toHaveLength(1);
    expect(await hasActiveSubscription(store, s.tenant.id, s.member.id)).toBe(true);
  });

  it("每期扣款：同一期只入帳一次、延長期間；扣款失敗 → past_due＋通知；之後成功 → 回 active", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-charge");
    const { sub } = await activeSub(s);
    s.nw.st.already = 2;
    expect((await s.notify(sub.id, charge(sub, 2))).outcome).toBe("charged:2");
    expect((await s.notify(sub.id, charge(sub, 2))).outcome).toBe("duplicate:2");
    expect((await store.listSubscriptionCharges(s.tenant.id, sub.id)).filter((c) => c.status === "paid")).toHaveLength(2);
    s.nw.st.already = 3;
    const f = await s.notify(sub.id, charge(sub, 3, false));
    expect(f.outcome).toBe("charge_failed:3");
    const pd = (await store.getSubscription(s.tenant.id, sub.id))!;
    expect(pd.status).toBe("past_due");
    expect(pd.grace_until).toBeTruthy();
    expect(s.sent.some((m) => m.subject.includes("扣款失敗"))).toBe(true);
    s.nw.st.already = 4;
    expect((await s.notify(sub.id, charge(sub, 4))).outcome).toBe("charged:4");
    expect((await store.getSubscription(s.tenant.id, sub.id))!).toMatchObject({ status: "active", grace_until: null, failed_count: 0 });
  });

  it("偽造的扣款通知：別的金鑰加密 → 解密失敗被拒；正確加密但回查未授權到這期 → 不入帳；交易查詢說未付 → 不入帳、要求重送、警示", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-forge");
    const { sub } = await activeSub(s);
    expect((await s.notify(sub.id, charge(sub, 2), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).outcome).toBe("decrypt");
    s.nw.st.already = 1; // 藍新實際只授權到第 1 期
    expect((await s.notify(sub.id, charge(sub, 2))).outcome).toBe("query_not_reached");
    s.nw.st.already = 2;
    s.nw.st.tradeStatus = "0";
    const r = await s.notify(sub.id, charge(sub, 2));
    expect(r.status).toBe(500);
    expect(s.sent.some((m) => m.subject.includes("無法確認"))).toBe(true);
    expect((await store.listSubscriptionCharges(s.tenant.id, sub.id)).filter((c) => c.period_index === 2)).toHaveLength(0);
    // 金額不符、別的委託單號、token 錯 → 都不入帳
    s.nw.st.tradeStatus = "1";
    expect((await s.notify(sub.id, charge(sub, 2, true, { AuthAmt: 1 }))).outcome).toBe("amount_mismatch");
    expect((await s.notify(sub.id, charge(sub, 2, true, { PeriodNo: "POTHER" }))).outcome).toBe("period_no");
    const bad = await handleSubscriptionNotify(s.deps, { tenantId: s.tenant.id, subscriptionId: sub.id, token: "x".repeat(32), rawBody: new URLSearchParams({ Period: enc(charge(sub, 2)) }).toString(), contentType: "application/x-www-form-urlencoded" });
    expect(bad.outcome).toBe("bad_token");
    // 回查失敗 → 要求重送
    s.nw.st.queryDown = true;
    expect((await s.notify(sub.id, charge(sub, 2))).status).toBe(500);
    s.nw.st.queryDown = false;
    // 交易查詢查無（藍新未保證每期可查）→ 依委託單查詢入帳（已知風險，見 ARCHITECTURE）
    s.nw.st.tradeStatus = null;
    expect((await s.notify(sub.id, charge(sub, 2))).outcome).toBe("charged:2");
  });

  it("試用期：10 元驗證成功 → active（試用）並開通；第 1 期稍後通知入帳", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-trial", { trialDays: 14 });
    const r = await subscribe(s.deps, { tenant: s.tenant, member: s.member, data: { planId: s.plan.id } });
    expect(Object.fromEntries(new URLSearchParams(aesCbcDecryptHex(r.form.fields.PostData_!, NW.hashKey, NW.hashIv)))).toMatchObject({ PeriodStartType: "1" });
    s.nw.st.already = 0;
    expect((await s.notify(r.subscription.id, creation(r.subscription, { TradeNo: undefined, RespondCode: undefined }))).outcome).toBe("active_trial");
    expect((await store.getSubscription(s.tenant.id, r.subscription.id))!).toMatchObject({ status: "active", entitlement_state: "granted" });
    s.nw.st.already = 1;
    expect((await s.notify(r.subscription.id, charge(r.subscription, 1))).outcome).toBe("charged:1");
  });

  it("建立失敗 → cancelled、不開通", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-createfail");
    const r = await subscribe(s.deps, { tenant: s.tenant, member: s.member, data: { planId: s.plan.id } });
    expect((await s.notify(r.subscription.id, { Status: "PER10061", Message: "授權失敗", Result: { MerchantID: NW.merchantId, MerchantOrderNo: r.subscription.merchant_order_no } })).outcome).toMatch(/^create_failed/);
    expect((await store.getSubscription(s.tenant.id, r.subscription.id))!).toMatchObject({ status: "cancelled", entitlement_state: "none" });
  });
});

describe("訂閱：寬限、停權、取消", () => {
  it("扣款失敗 → 寬限期到 → 停權（expired）、收回課程；重跑 sweep 冪等", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-grace", { course: true });
    const { sub } = await activeSub(s);
    s.nw.st.already = 2;
    await s.notify(sub.id, charge(sub, 2, false));
    expect((await sweepSubscriptions(s.deps, new Date(Date.now() + 3 * D))).expired).toBe(0); // 寬限期內
    const r = await sweepSubscriptions(s.deps, new Date(Date.now() + 8 * D));
    expect(r).toMatchObject({ expired: 1, revoked: 1 });
    expect((await store.getSubscription(s.tenant.id, sub.id))!).toMatchObject({ status: "expired", entitlement_state: "revoked" });
    expect((await store.getEnrollment(s.tenant.id, s.course!.id, s.member.id))!.status).toBe("revoked");
    expect(await sweepSubscriptions(s.deps, new Date(Date.now() + 9 * D))).toMatchObject({ expired: 0, revoked: 0 });
    // 停權後才收到成功扣款 → 不復活、警示店主退款
    s.nw.st.already = 3;
    expect((await s.notify(sub.id, charge(sub, 3))).outcome).toBe("paid_after_end:3");
    expect((await store.getSubscription(s.tenant.id, sub.id))!.status).toBe("expired");
  });

  it("應扣未扣（期間到了沒收到通知）→ past_due 寬限", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-missing");
    const { sub } = await activeSub(s);
    expect((await sweepSubscriptions(s.deps, new Date(Date.now() + 40 * D))).pastDue).toBe(1);
    expect((await store.getSubscription(s.tenant.id, sub.id))!.status).toBe("past_due");
  });

  it("會員取消：終止委託成功 → cancelled、權益保留到期間結束、到期後收回；只能取消自己的", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-cancel", { course: true });
    const { sub } = await activeSub(s);
    const other = (await store.insertMember({ tenant_id: s.tenant.id, email: "other@example.com", password_hash: "x", name: "別人", phone: null }))!;
    await expect(memberCancelSubscription(s.deps, { tenant: s.tenant, member: other, subscriptionId: sub.id })).rejects.toMatchObject({ code: "not_found" });
    const r = await memberCancelSubscription(s.deps, { tenant: s.tenant, member: s.member, subscriptionId: sub.id });
    expect(r).toMatchObject({ status: "cancelled", cancelState: "done" });
    expect(s.nw.st.terminates).toBe(1);
    const row = (await store.getSubscription(s.tenant.id, sub.id))!;
    expect(row.entitlement_state).toBe("granted");
    expect(await hasActiveSubscription(store, s.tenant.id, s.member.id)).toBe(true);
    await sweepSubscriptions(s.deps, new Date(Date.parse(row.ended_at!) + 1000));
    expect((await store.getSubscription(s.tenant.id, sub.id))!.entitlement_state).toBe("revoked");
    expect((await store.getEnrollment(s.tenant.id, s.course!.id, s.member.id))!.status).toBe("revoked");
  });

  it("終止委託失敗 → 記錄錯誤與次數、狀態不變；cron 重試成功後才 cancelled；PER10065（已終止）視同成功", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-cancelfail");
    const { sub } = await activeSub(s);
    s.nw.st.terminate = "down";
    const r = await memberCancelSubscription(s.deps, { tenant: s.tenant, member: s.member, subscriptionId: sub.id });
    expect(r.cancelState).toBe("failed");
    expect((await store.getSubscription(s.tenant.id, sub.id))!).toMatchObject({ status: "active", cancel_state: "failed", cancel_attempts: 1 });
    s.nw.st.terminate = "PER10065";
    expect((await sweepSubscriptions(s.deps)).cancelRetried).toBe(1);
    expect((await store.getSubscription(s.tenant.id, sub.id))!).toMatchObject({ status: "cancelled", cancel_state: "done" });
  });

  it("MCP／後台 cancel_subscription 需 confirm；list_subscriptions 遮罩 email", async () => {
    const store = newStore();
    const s = await subShop(store, "sub-mcp");
    const { sub } = await activeSub(s);
    const ctx = { ...ctxFor(store), sendMail: s.deps.sendMail };
    await expect(cancelSubscription(ctx, { site: "sub-mcp", subscriptionId: sub.id })).rejects.toMatchObject({ code: "confirm_required" });
    expect(s.nw.st.terminates).toBe(0);
    const l = await listSubscriptions(ctx, { site: "sub-mcp" });
    expect(JSON.stringify(l)).not.toContain("sub@example.com");
    // 測試用：注入 provider 的 deps 不經 ctx，所以這裡直接用 requestCancel 的服務入口
    expect(l.subscriptions[0]).toMatchObject({ status: "active", amount: 299 });
  });
});
