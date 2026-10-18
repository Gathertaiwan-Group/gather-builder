/**
 * 整合測試（npm run test:db）：第四批（events／booking／courses）在真 DB 上的原子性。
 * 建 is_test 租戶，跑完刪除（cascade）並清掉限流列。🔴 不寄信（沒有 sendMail）、不呼叫任何金流 API。
 */
import { afterAll, describe, expect, it } from "vitest";
import { createServiceClient, createSupabaseStore } from "@/lib/store/supabase";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { cancelOrder, expireIfDue, markOrderPaid } from "@/lib/services/orders";
import { createEvent, createSession, createTicketType, joinWaitlist, registerEvent } from "@/lib/services/events";
import { bookSlot, createService, setWeeklyHours } from "@/lib/services/booking";
import { addLesson, buyCourse, createCourse, lessonForViewer, onCourseOrderPaid, updateCourse } from "@/lib/services/courses";
import { addDays, taipeiDateOf } from "@/lib/booking/availability";
import { adminActor } from "@/lib/tokens";
import type { ServiceContext } from "@/lib/services/context";

const enabled = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.PAYMENT_ENC_KEY;
const ts = Date.now().toString(36);
const slug = `itcls-${ts}`;
const H = 3600_000;
const who = (n: string) => ({ name: `測試${n}`, email: `cls-${n}-${ts}@example.com`, phone: "0912345678" });

describe.skipIf(!enabled)("第四批 Supabase 實作（整合）", () => {
  const store = enabled ? createSupabaseStore() : (null as never);
  const ctx: ServiceContext = { actor: { ...adminActor(), label: "itest" }, store, baseUrl: "http://itest", previewSecret: "itest-secret-xxxx" };
  const deps = { store, baseUrl: "http://itest" };

  afterAll(async () => {
    if (!enabled) return;
    const db = createServiceClient();
    const t = await db.from("builder_tenants").select("id").eq("slug", slug).maybeSingle();
    if (t.data) await db.from("builder_rate_limits").delete().like("bucket", `%${t.data.id}%`);
    await db.from("builder_tenants").delete().eq("slug", slug);
    expect((await db.from("builder_tenants").select("id").eq("slug", slug)).data).toEqual([]);
  });

  it("建立測試網站（events＋shop，is_test）", async () => {
    process.env.PREVIEW_SECRET ??= "itest-preview-secret-xxxx";
    await createSite(ctx, { slug, name: slug, modules: ["events", "shop", "booking", "courses"], test: true });
    await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "test" }, orderPrefix: "IC" } });
    await publishSite(ctx, { site: slug, confirm: true });
    await createEvent(ctx, { site: slug, slug: "race", title: "搶位", status: "published", confirm: true });
  });

  it("events：併發 8 人搶最後 1 席（免費票）→ 只成功 1 筆", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "race", startsAt: new Date(Date.now() + 72 * H).toISOString(), endsAt: new Date(Date.now() + 74 * H).toISOString(), capacity: 1, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "免費", price: 0, confirm: true });
    const r = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: who(`f${i}`) } })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const f of r.filter((x) => x.status === "rejected")) expect(String((f as PromiseRejectedResult).reason.message)).toMatch(/名額已滿/);
    const rows = await store.listRegistrations(t.id, { sessionId: s.id, status: ["confirmed", "held"], limit: 10, offset: 0 });
    expect(rows.total).toBe(1);
  });

  it("events：併發 6 人搶最後 1 席（付費票，各自建訂單）→ 只成立 1 張訂單、其餘整筆回滾", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "race", startsAt: new Date(Date.now() + 96 * H).toISOString(), endsAt: new Date(Date.now() + 98 * H).toISOString(), capacity: 1, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "付費", price: 500, confirm: true });
    const before = (await store.listOrders(t.id, { limit: 1, offset: 0 })).total;
    const r = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: who(`p${i}`), paymentMethod: "offline" } })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await store.listOrders(t.id, { limit: 1, offset: 0 })).total).toBe(before + 1);
    const ok = (r.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof registerEvent>>>).value;
    if (ok.kind !== "order") throw new Error("expected order");
    const items = await store.listOrderItems(t.id, ok.order.id);
    expect(items[0]).toMatchObject({ item_kind: "event_ticket", ref_id: tk.id, product_id: null });

    // 候補：額滿才能登記；保留逾期 → builder_cancel_order 同交易釋放 → 遞補（保留佔名額，重複呼叫冪等）
    const w = await joinWaitlist(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, contact: who("w1") } });
    expect(w.position).toBe(1);
    const db = createServiceClient();
    // 測試用時間注入：把保留期限改到過去（只限本測試建立的 is_test 租戶訂單）
    await db.from("builder_orders").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", ok.order.id).eq("tenant_id", t.id);
    const o = (await store.getOrderById(t.id, ok.order.id))!;
    await expireIfDue(store, o, Date.now(), { store, baseUrl: "http://itest" });
    expect((await store.getOrderById(t.id, o.id))!.status).toBe("cancelled");
    expect((await store.listRegistrations(t.id, { orderId: o.id, limit: 5, offset: 0 })).rows[0]!.status).toBe("expired");
    const wl = await store.listWaitlist(t.id, s.id);
    expect(wl[0]!.status).toBe("offered");
    expect(await store.offerWaitlist(t.id, s.id, 24)).toEqual([]); // 冪等
    // 保留期間：別人搶不到
    await expect(registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 1, contact: who("late"), paymentMethod: "offline" } })).rejects.toThrow(/名額已滿/);
    // 保留過期 → lapsed（這裡沒有下一位）
    await db.from("builder_event_waitlist").update({ offer_expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", wl[0]!.id);
    expect(await store.offerWaitlist(t.id, s.id, 24)).toEqual([]);
    expect((await store.getWaitlist(t.id, wl[0]!.id))!.status).toBe("lapsed");
  });

  it("events：付款後確認；取消已付款訂單 → 名額同交易釋放（冪等，重複取消不會多釋放）", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const s = await createSession(ctx, { site: slug, eventSlug: "race", startsAt: new Date(Date.now() + 120 * H).toISOString(), endsAt: new Date(Date.now() + 121 * H).toISOString(), capacity: 2, confirm: true });
    const tk = await createTicketType(ctx, { site: slug, sessionId: s.id, name: "付費", price: 300, confirm: true });
    const r = await registerEvent(deps, { tenant: t, member: null, data: { sessionId: s.id, ticketTypeId: tk.id, qty: 2, contact: who("pp"), paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    await markOrderPaid(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    const reg = (await store.listRegistrations(t.id, { orderId: r.order.id, limit: 5, offset: 0 })).rows[0]!;
    expect(reg.status).toBe("confirmed");
    expect(reg.checkin_code_hash).toBeTruthy();
    expect((await store.sessionUsage(t.id, s.id)).taken).toBe(2);
    await cancelOrder(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    expect((await store.sessionUsage(t.id, s.id)).taken).toBe(0);
    expect((await store.cancelOrder(t.id, r.order.id, ["paid", "pending_payment"], "x")).transitioned).toBe(false);
    const db = createServiceClient();
    expect(Number((await db.rpc("builder_release_order_reservations", { p_tenant: t.id, p_order: r.order.id })).data)).toBe(0);
  });

  it("booking：併發 6 筆搶同一時段（不收費）→ 只成功 1 筆；DB 第二道防線（partial unique）也擋得住", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const sv = await createService(ctx, { site: slug, slug: "race", name: "搶時段", durationMin: 60, bufferMin: 10, status: "published", confirm: true });
    await setWeeklyHours(ctx, { site: slug, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })), confirm: true });
    const date = addDays(taipeiDateOf(new Date()), 4);
    const at = (hm: string) => new Date(`${date}T${hm}:00+08:00`).toISOString();
    const r = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => bookSlot(deps, { tenant: t, member: null, data: { serviceId: sv.id, startsAt: at("10:00"), contact: who(`b${i}`) } })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const f of r.filter((x) => x.status === "rejected")) expect(String((f as PromiseRejectedResult).reason.message)).toMatch(/預約走了|無法預約/);
    // 部分重疊（10:30 與 10:00–11:10 重疊）在 DB 層也擋
    const p = (await store.listProviders(t.id))[0]!;
    await expect(store.reserveBookingFree(t.id, { provider_id: p.id, service_id: sv.id, starts_at: at("10:30"), ends_at: at("11:30"), block_until: at("11:40"), price: 0, amount_due: 0, contact: who("x"), member_id: null, note: null })).rejects.toThrow(/預約走了/);
    // 併發改期到同一個空時段 → 只成功一筆
    const b1 = await bookSlot(deps, { tenant: t, member: null, data: { serviceId: sv.id, startsAt: at("13:00"), contact: who("m1") } });
    const b2 = await bookSlot(deps, { tenant: t, member: null, data: { serviceId: sv.id, startsAt: at("15:00"), contact: who("m2") } });
    if (b1.kind !== "confirmed" || b2.kind !== "confirmed") throw new Error("expected confirmed");
    const mv = await Promise.allSettled([store.rescheduleBooking(t.id, b1.booking.id, at("16:30"), at("17:30"), at("17:40")), store.rescheduleBooking(t.id, b2.booking.id, at("16:30"), at("17:30"), at("17:40"))]);
    expect(mv.filter((x) => x.status === "fulfilled" && x.value === true)).toHaveLength(1);
  });

  it("booking：付費（全額）預約的保留在取消訂單時同交易釋放", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    const sv = await createService(ctx, { site: slug, slug: "paid", name: "付費", durationMin: 30, price: 800, paymentMode: "full", status: "published", confirm: true });
    const date = addDays(taipeiDateOf(new Date()), 5);
    const at = (hm: string) => new Date(`${date}T${hm}:00+08:00`).toISOString();
    const r = await bookSlot(deps, { tenant: t, member: null, data: { serviceId: sv.id, startsAt: at("09:00"), contact: who("pay"), paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    expect((await store.getBooking(t.id, r.bookingId!))!.status).toBe("held");
    await cancelOrder(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    expect((await store.getBooking(t.id, r.bookingId!))!.status).toBe("cancelled");
    await expect(bookSlot(deps, { tenant: t, member: null, data: { serviceId: sv.id, startsAt: at("09:00"), contact: who("pay2"), paymentMethod: "offline" } })).resolves.toMatchObject({ kind: "order" });
  });

  it("courses：付款成功才開通；併發 6 次觸發付款 hook 只開通 1 次；取消訂單撤銷；未開通拿不到影片網址", async () => {
    const t = (await store.getTenantBySlug(slug))!;
    await createCourse(ctx, { site: slug, slug: "itc", title: "整合課", price: 900 });
    await addLesson(ctx, { site: slug, courseSlug: "itc", slug: "l1", title: "付費單元", videoUrl: "https://youtu.be/ITpaidVID01" });
    await updateCourse(ctx, { site: slug, slug: "itc", patch: { status: "published" }, confirm: true });
    const m = (await store.insertMember({ tenant_id: t.id, email: `stu-${ts}@example.com`, password_hash: "x", name: "學生", phone: null }))!;
    const c = (await store.getCourseBySlug(t.id, "itc"))!;
    const r = await buyCourse(deps, { tenant: t, member: m, data: { courseId: c.id, contact: { name: "學生", phone: "0912345678" }, paymentMethod: "offline" } });
    if (r.kind !== "order") throw new Error("expected order");
    const locked = (await lessonForViewer(store, t, "itc", "l1", m))!;
    expect(JSON.stringify(locked)).not.toContain("ITpaidVID01");
    await markOrderPaid(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    const paid = (await store.getOrderById(t.id, r.order.id))!;
    await Promise.all(Array.from({ length: 6 }, () => onCourseOrderPaid({ store, baseUrl: "http://itest" }, t, paid)));
    const db = createServiceClient();
    const rows = await db.from("builder_course_enrollments").select("id, status, source, order_id").eq("tenant_id", t.id).eq("member_id", m.id);
    expect(rows.data).toHaveLength(1);
    expect(rows.data![0]).toMatchObject({ status: "active", source: "order", order_id: r.order.id });
    // 併發 grant 也只有一筆「真的開通」
    const g = await Promise.all(Array.from({ length: 5 }, () => store.grantEnrollment(t.id, { courseId: c.id, memberId: m.id, source: "order", orderId: r.order.id, by: "it" })));
    expect(g.filter((x) => x.granted)).toHaveLength(0);
    // 撤銷後併發重新開通：只有一筆 granted=true
    await store.revokeEnrollment(t.id, { courseId: c.id, memberId: m.id }, { by: "it", reason: "race" });
    const g2 = await Promise.all(Array.from({ length: 5 }, () => store.grantEnrollment(t.id, { courseId: c.id, memberId: m.id, source: "order", orderId: r.order.id, by: "it" })));
    expect(g2.filter((x) => x.granted)).toHaveLength(1);
    expect((await lessonForViewer(store, t, "itc", "l1", m))!.lesson.videoUrl).toContain("ITpaidVID01");
    await cancelOrder(ctx, { site: slug, orderNo: r.order.order_no, confirm: true });
    expect((await store.getEnrollment(t.id, c.id, m.id))!.status).toBe("revoked");
    expect((await lessonForViewer(store, t, "itc", "l1", m))!.allowed).toBe(false);
    expect(await store.revokeEnrollment(t.id, { orderId: r.order.id }, { by: "it", reason: "again" })).toEqual([]);
  });
});
