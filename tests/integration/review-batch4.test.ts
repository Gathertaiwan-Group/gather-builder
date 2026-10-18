/**
 * 整合測試（npm run test:db）：第四批審查修正在真 DB 上的行為。
 * M1 個資查看紀錄 update／delete 被拒（42501）；M3 builder_mark_paid_sandbox 同交易釋放保留；
 * M5 同 email 併發報名只成功 1 筆、逾期未確認保留被釋放；L5 builder_norm_email 與 TS 同規則、首單判斷用正規化 email。
 * 建 is_test 租戶，跑完刪除。🔴 不寄信、不呼叫金流。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { markOrderPaid } from "@/lib/services/orders";
import { createEvent, createSession, createTicketType, registerEvent } from "@/lib/services/events";
import { normalizeEmail } from "@/lib/email-normalize";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itrv4-${ts}`;
const H = 3600_000;

describe.skipIf(!enabled)("第四批審查修正（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const db = enabled ? createServiceClient() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };
  const deps = { store, baseUrl: "http://itest" };

  afterAll(async () => {
    if (!enabled) return;
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試網站", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["events", "shop"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "RV" } });
    await publishSite(ctx, { site: slug, confirm: true });
    await createEvent(ctx, { site: slug, slug: "ev", title: "審查", status: "published", confirm: true });
  });

  it("M1：builder_pii_access_log 只增不改（update／delete → 42501）", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    await store.insertPiiLog({ tenant_id: t.id, actor: "itest", action: "reveal", subject_type: "test", subject_id: null, detail: null });
    const up = await db.from("builder_pii_access_log").update({ actor: "x" }).eq("tenant_id", t.id);
    expect(up.error?.code).toBe("42501");
    const del = await db.from("builder_pii_access_log").delete().eq("tenant_id", t.id);
    expect(del.error?.code).toBe("42501");
    expect((await store.listPiiLog(t.id, 5)).length).toBe(1);
  });

  it("M5：同一 email 併發 6 筆免費報名 → 只成功 1 筆；逾期未確認的保留在下次報名時被釋放", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "ev", startsAt: new Date(Date.now() + 72 * H).toISOString(), endsAt: new Date(Date.now() + 74 * H).toISOString(), capacity: 10, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "免費", price: 0, confirm: true });
    const c = (email: string) => ({ name: "測試者", email, phone: "0912345678" });
    const r = await Promise.allSettled(["Same.Person@gmail.com", "sameperson@gmail.com", "same.person+1@gmail.com", "SAMEPERSON@googlemail.com", "same.per.son@gmail.com", "sameperson+z@gmail.com"].map((e) => registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: c(e) } })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const ok = (r.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof registerEvent>>>).value;
    expect(ok.kind).toBe("pending");
    // 把保留期限改到過去（模擬 30 分鐘後），同一人再報名 → SQL 先釋放舊保留再接受
    await db.from("builder_event_registrations").update({ hold_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", ok.registration.id);
    const again = await registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: c("sameperson@gmail.com") } });
    expect(again.kind).toBe("pending");
    expect((await store.getRegistration(t.id, ok.registration.id))!.status).toBe("expired");
  });

  it("M3：builder_mark_paid_sandbox 同交易轉 paid＋釋放報名保留", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "ev", startsAt: new Date(Date.now() + 96 * H).toISOString(), endsAt: new Date(Date.now() + 98 * H).toISOString(), capacity: 1, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "付費", price: 400, confirm: true });
    const r = await registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: { name: "沙盒", email: `sbx-${ts}@example.com`, phone: "0912345678" }, paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    const moved = await store.markPaidSandbox(t.id, r.order.id, new Date().toISOString());
    expect(moved).toMatchObject({ status: "paid", payment_sandbox: true });
    expect(await store.markPaidSandbox(t.id, r.order.id, new Date().toISOString())).toBeNull();
    expect((await store.getRegistration(t.id, r.registrationId!))!).toMatchObject({ status: "cancelled", cancel_reason: "sandbox_payment" });
  });

  it("L5：builder_norm_email 與 lib/email-normalize.ts 同規則；首單判斷用正規化 email", async () => {
    const samples = [" A.B+promo@GMail.com ", "a.b@googlemail.com", "x+y@example.com", "+x@example.com", "noat", "a@b@c.com", "First.Last@Example.COM"];
    for (const e of samples) {
      const r = await db.rpc("builder_norm_email", { p: e });
      expect(r.error).toBeNull();
      expect(r.data).toBe(normalizeEmail(e));
    }
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "ev", startsAt: new Date(Date.now() + 120 * H).toISOString(), endsAt: new Date(Date.now() + 122 * H).toISOString(), capacity: 5, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "付費", price: 300, confirm: true });
    const r = await registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: { name: "首單", email: `First.Buyer.${ts}@gmail.com`, phone: "0912345678" }, paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    await markOrderPaid(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    expect(await store.countPaidOrdersFor(t.id, { memberId: null, email: `firstbuyer${ts}+again@googlemail.com` }, "00000000-0000-0000-0000-000000000000")).toBe(1);
    expect(await store.countPaidOrdersFor(t.id, { memberId: null, email: `other-${ts}@gmail.com` }, "00000000-0000-0000-0000-000000000000")).toBe(0);
  });

  it("M2：hook 失敗紀錄表可寫、可補做（attempts 累加、resolved）", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const o = (await store.listOrders(t.id, { limit: 1, offset: 0 })).rows[0]!;
    await store.recordHookFailure({ tenant_id: t.id, order_id: o.id, hook: "itest", event: "paid", error: "e1" });
    await store.recordHookFailure({ tenant_id: t.id, order_id: o.id, hook: "itest", event: "paid", error: "e2" });
    const open = await store.listOpenHookFailures({ orderId: o.id, limit: 5, maxAttempts: 20 });
    expect(open).toMatchObject([{ hook: "itest", attempts: 2, last_error: "e2" }]);
    expect(await store.bumpHookFailure(open[0]!.id, "e3")).toBe(3);
    expect(await store.markHookFailureAlerted(open[0]!.id)).toBe(true);
    expect(await store.markHookFailureAlerted(open[0]!.id)).toBe(false);
    await store.resolveHookFailure(open[0]!.id, "retried");
    expect(await store.listOpenHookFailures({ orderId: o.id, limit: 5, maxAttempts: 20 })).toHaveLength(0);
  });
});
