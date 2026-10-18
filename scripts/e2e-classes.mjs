#!/usr/bin/env node
// 第四批端到端（events＋booking＋courses）：MCP 開站（is_test）→ 啟用模組 → 建活動場次票種（容量 1）→ 會員 A 報名付費票（線下匯款）→
// 會員 B 額滿登記候補 → A 的保留逾期（測試用時間注入：把 is_test 租戶那張訂單的 expires_at 改到過去）→ B 收到遞補 →
// B 用遞補連結報名 → mark_order_paid → 名單 CSV 正確（含 CSV injection 跳脫）；
// 建服務與每週時段 → 預約一個時段 → 同時段第二筆被拒 → .ics 正確；
// 建課程與單元 → 購買（線下匯款）→ 未付款時看不到付費單元（HTML 不含影片網址）→ mark_order_paid → 會員中心看得到課程並可上課。
// 🔴 不碰真實金流（線下匯款）、所有 email 用 example.com（不會實際寄出）。
// 用法：node --env-file=.env.local scripts/e2e-classes.mjs [baseUrl] [--quick] [--admin-base=http://localhost:3210]
//   需要 GB_PLATFORM_TOKEN（含 classes:write／attendees:* 的平台 token）、ADMIN_PASSWORD、SUPABASE_URL＋SUPABASE_SERVICE_ROLE_KEY（時間注入）、
//   PREVIEW_SECRET（與伺服器相同時才能重算遞補連結；--quick 跳過遞補認領）。
import { createHmac } from "node:crypto";
import { connect, check, done } from "./mcp-client.mjs";

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith("http")) ?? "http://localhost:3210";
const quick = args.includes("--quick");
const adminBase = (args.find((a) => a.startsWith("--admin-base=")) ?? "").slice("--admin-base=".length) || base;
const { GB_PLATFORM_TOKEN: platformToken, ADMIN_PASSWORD: adminPassword, SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey, PREVIEW_SECRET: previewSecret } = process.env;
if (!platformToken || !adminPassword || !sbUrl || !sbKey) {
  console.error("需要 GB_PLATFORM_TOKEN、ADMIN_PASSWORD、SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const ts = Date.now().toString(36);
const slug = `e2e-cls-${ts}`;
console.log(`base=${base} slug=${slug}${quick ? " (quick)" : ""}\n`);
const H = 3600_000;

async function post(path, fields, cookie, at = base) {
  const res = await fetch(`${at}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: at, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}
async function get(path, cookie, at = base) {
  const res = await fetch(`${at}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {}, cache: "no-store" });
  return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text(), type: res.headers.get("content-type") ?? "" };
}
const flash = (loc) => {
  const u = new URL(loc || "/", base);
  return { ok: u.searchParams.get("ok"), err: u.searchParams.get("err") };
};
/** service role REST（只用來做測試用時間注入與讀候補列；只動這次建立的 is_test 租戶） */
async function rest(method, path, body) {
  const res = await fetch(`${sbUrl}/rest/v1/${path}`, { method, headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "content-type": "application/json", Prefer: "return=representation" }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
async function member(email, name) {
  const password = `pw-${ts}-${name}-secure`;
  await post(`/s/${slug}/api/account/register`, { email, password, name, phone: "0912000111" });
  const lg = await post(`/s/${slug}/api/account/login`, { email, password });
  return lg.setCookie.split(";")[0];
}

/* ---------------------------------------------------------------- 開站 */
const platform = await connect(base, platformToken);
const created = await platform.call("create_site", { slug, name: `E2E 課程 ${ts}`, modules: ["sections-basic"], test: true });
check(created.token?.startsWith("gbt_"), "create_site（測試租戶 is_test）", created.__error ?? "");
check(["classes:write", "attendees:read", "attendees:write"].every((s) => created.tokenScopes?.includes(s)), "網站 token 含第四批 scope", created.tokenScopes?.join(","));
await platform.close();
const site = await connect(base, created.token);
const tools = (await site.client.listTools()).tools.map((t) => t.name);
check(["create_event", "create_session", "create_ticket_type", "list_registrations", "check_in", "cancel_session"].every((t) => tools.includes(t)), "MCP 有 events 工具", `${tools.length} 個工具`);

await site.call("enable_module", { moduleId: "members" });
await site.call("enable_module", { moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "請匯款至 測試銀行 000-123456" }, orderPrefix: "CLS" } });
const en = await site.call("enable_module", { moduleId: "events" });
check(en.changed?.some((c) => c.id === "events" && c.status === "enabled"), "enable_module events", en.__error ?? JSON.stringify(en.changed));

/* ---------------------------------------------------------------- events */
const ev = await site.call("create_event", { slug: "clay", title: `E2E 陶藝工作坊 ${ts}`, location: "台中市測試路 1 號", bodyMd: "做一個杯子" });
check(ev.status === "draft", "create_event（草稿）", ev.__error ?? "");
const start = new Date(Date.now() + 5 * 24 * H);
const sess = await site.call("create_session", { eventSlug: "clay", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * H).toISOString(), capacity: 1 });
check(!!sess.id && sess.capacity === 1, "create_session（容量 1）", sess.__error ?? "");
const tk = await site.call("create_ticket_type", { sessionId: sess.id, name: "一般票", price: 600 });
check(!!tk.id && tk.price === 600, "create_ticket_type（NT$600）", tk.__error ?? "");
const pubNo = await site.call("update_event", { slug: "clay", patch: { status: "published" } });
check(pubNo.__error?.startsWith("[confirm_required]"), "上架活動沒 confirm → confirm_required");
const pubEv = await site.call("update_event", { slug: "clay", patch: { status: "published" }, confirm: true });
check(pubEv.status === "published", "update_event 上架（confirm）", pubEv.__error ?? "");
await site.call("add_section", { path: "/", type: "events_list", props: { heading: "近期活動" } });

/* ---------------------------------------------------------------- 發布網站 */
const pv = await site.call("preview_changes");
const pub = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv.draftVersion, note: "e2e classes" });
check(pub.revision >= 1, "publish_site", pub.__error ?? "");

const page = await get(`/s/${slug}/events/clay`);
check(page.status === 200 && page.body.includes("剩 1 位"), "活動頁顯示剩 1 位");

const emailA = `e2e-cls-a-${ts}@example.com`;
const emailB = `e2e-cls-b-${ts}@example.com`;
const cookieA = await member(emailA, "王小明");
const cookieB = await member(emailB, "李大華");
check(/^gbm_/.test(cookieA) && /^gbm_/.test(cookieB), "會員 A、B 註冊＋登入");

const regA = await post(`/s/${slug}/api/events/register`, { sessionId: sess.id, ticketTypeId: tk.id, qty: "1", name: "王小明", email: emailA, phone: "0912000111", paymentMethod: "offline" }, cookieA);
check(regA.status === 303 && /\/orders\/CLS-/.test(regA.location), "A 報名付費票（線下匯款）→ 訂單頁", regA.location.slice(0, 90));
const orderNoA = decodeURIComponent(/\/orders\/([^?]+)/.exec(regA.location)?.[1] ?? "");
const regB1 = await post(`/s/${slug}/api/events/register`, { sessionId: sess.id, ticketTypeId: tk.id, qty: "1", name: "李大華", email: emailB, phone: "0912000222", paymentMethod: "offline" }, cookieB);
check(/名額已滿/.test(flash(regB1.location).err ?? ""), "B 報名 → 額滿被拒（A 的保留佔名額）", flash(regB1.location).err ?? "");
const wl = await post(`/s/${slug}/api/events/waitlist`, { sessionId: sess.id, ticketTypeId: tk.id, qty: "1", name: "=李大華", email: emailB, phone: "+886912000222" }, cookieB);
check(/候補/.test(flash(wl.location).ok ?? ""), "B 登記候補", flash(wl.location).ok ?? flash(wl.location).err);

// 測試用時間注入：A 的保留到期（只改這次建立的 is_test 租戶那張訂單）
const tenantRow = (await rest("GET", `builder_tenants?slug=eq.${slug}&select=id,is_test`))[0];
check(tenantRow?.is_test === true, "測試租戶 is_test=true");
await rest("PATCH", `builder_orders?tenant_id=eq.${tenantRow.id}&order_no=eq.${encodeURIComponent(orderNoA)}`, { expires_at: new Date(Date.now() - 60_000).toISOString() });
const lr = await site.call("list_registrations", { sessionId: sess.id });
check(lr.registrations?.some((r) => r.status === "expired"), "A 的保留逾期 → 報名 expired（名單讀取時 lazy 釋放）", lr.__error ?? JSON.stringify(lr.registrations?.map((r) => r.status)));
const waitRows = await rest("GET", `builder_event_waitlist?tenant_id=eq.${tenantRow.id}&select=id,status,offer_expires_at`);
check(waitRows?.[0]?.status === "offered", "B 收到遞補（保留中）", JSON.stringify(waitRows));
const oa = await site.call("get_order", { orderNo: orderNoA });
check(oa.status === "cancelled" && oa.cancelReason === "expired", "A 的訂單逾期取消", `${oa.status}/${oa.cancelReason}`);
const evs = await site.call("list_events");
check(evs.events?.[0]?.sessions?.[0]?.offered === 1 && evs.events[0].sessions[0].remaining === 0, "list_events：保留 1、剩 0（保留佔名額）", JSON.stringify(evs.events?.[0]?.sessions?.[0] ?? evs.__error));

let orderNoB = "";
if (!quick && previewSecret) {
  const offerId = waitRows[0].id;
  const tok = createHmac("sha256", previewSecret).update(`offer:${offerId}`).digest("base64url").slice(0, 32);
  const offerPage = await get(`/s/${slug}/events/clay?offer=${offerId}&t=${tok}`, cookieB);
  check(offerPage.status === 200 && offerPage.body.includes("候補遞補"), "B 開遞補連結看到保留");
  const regB = await post(`/s/${slug}/api/events/register`, { sessionId: sess.id, ticketTypeId: tk.id, qty: "1", name: "=李大華", email: emailB, phone: "+886912000222", paymentMethod: "offline", offerId, offerToken: tok }, cookieB);
  check(regB.status === 303 && /\/orders\/CLS-/.test(regB.location), "B 用遞補連結報名 → 訂單", regB.location.slice(0, 80) || flash(regB.location).err);
  orderNoB = decodeURIComponent(/\/orders\/([^?]+)/.exec(regB.location)?.[1] ?? "");
  const paidB = await site.call("mark_order_paid", { orderNo: orderNoB, confirm: true });
  check(paidB.status === "paid", "mark_order_paid（B）", paidB.__error ?? "");
  const lr2 = await site.call("list_registrations", { sessionId: sess.id, status: ["confirmed"] });
  check(lr2.registrations?.length === 1 && lr2.registrations[0].source === "waitlist" && lr2.registrations[0].contact.email.includes("＊"), "B 的報名 confirmed（來源 waitlist、名單遮罩）", JSON.stringify(lr2.registrations?.[0] ?? lr2.__error));
  const acct = await get(`/s/${slug}/account`, cookieB);
  check(acct.body.includes("我的報名") && /data-gb="checkin-code">[A-Z2-9]{10}</.test(acct.body), "B 的會員中心：我的報名＋簽到碼");
} else {
  console.log("SKIP  遞補認領（--quick 或沒有 PREVIEW_SECRET）");
}

// 名單 CSV（後台；會留查看紀錄）
const login = await post("/api/admin/login", { password: adminPassword }, undefined, adminBase);
const adminCookie = login.setCookie.split(";")[0];
check(login.status === 303 && adminCookie.startsWith("gb_admin="), "後台登入");
if (orderNoB) {
  const csv = await get(`/api/admin/tenants/${slug}/events/roster?session=${sess.id}`, adminCookie, adminBase);
  check(csv.status === 200 && /text\/csv/.test(csv.type), "後台匯出名單 CSV");
  check(csv.body.includes(`"'=李大華"`) && csv.body.includes(`"'+886912000222"`) && csv.body.includes(emailB) && csv.body.includes(orderNoB), "CSV 內容正確且 = + 開頭的值已跳脫", csv.body.split("\r\n")[1]?.slice(0, 160));
  const pii = await rest("GET", `builder_pii_access_log?tenant_id=eq.${tenantRow.id}&select=action,actor`);
  check(pii?.some((p) => p.action === "export" && p.actor === "admin"), "匯出留下查看紀錄（who/when）");
}

/* ---------------------------------------------------------------- booking */
const eb = await site.call("enable_module", { moduleId: "booking", config: { location: "台北市測試路 9 號", minLeadMinutes: 60 } });
check(eb.changed?.some((c) => c.id === "booking" && c.status === "enabled"), "enable_module booking", eb.__error ?? JSON.stringify(eb.changed));
const svc = await site.call("create_service", { slug: "consult", name: "一對一諮詢", durationMin: 60, bufferMin: 15, price: 1200, status: "published", confirm: true });
check(svc.id && svc.paymentMode === "none", "create_service（60 分＋緩衝 15、現場付）", svc.__error ?? "");
const whNo = await site.call("set_weekly_hours", { hours: [{ weekday: 1, start: "09:00", end: "18:00" }] });
check(whNo.__error?.startsWith("[confirm_required]"), "set_weekly_hours 沒 confirm → confirm_required");
const wh = await site.call("set_weekly_hours", { confirm: true, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "18:00" })) });
check(wh.hours?.length === 7, "set_weekly_hours（每天 09:00–18:00）", wh.__error ?? "");
await site.call("add_section", { path: "/", type: "booking_widget", props: { heading: "線上預約" } });
const pv2 = await site.call("preview_changes");
const pub2 = await site.call("publish_site", { confirm: true, expectedDraftVersion: pv2.draftVersion, note: "e2e booking" });
check(pub2.revision >= 2, "publish_site（booking 設定生效）", pub2.__error ?? "");
const d3 = new Date(Date.now() + 3 * 24 * H + 8 * H).toISOString().slice(0, 10);
const av = await site.call("get_booking_availability", { serviceSlug: "consult", fromDate: d3, days: 1 });
const slot = av.days?.[0]?.slots?.find((x) => x.label === "10:00");
check(!!slot, "get_booking_availability：3 天後 10:00 可約", av.__error ?? JSON.stringify(av.days?.[0]?.slots?.slice(0, 3)));
const bookPage = await get(`/s/${slug}/book?service=consult&from=${d3}`);
check(bookPage.status === 200 && bookPage.body.includes(`data-start="${slot?.start}"`), "/book 頁顯示該時段");
const bk1 = await post(`/s/${slug}/api/booking/book`, { serviceId: svc.id, startsAt: slot.start, name: "王小明", email: emailA, phone: "0912000111" }, cookieA);
check(bk1.status === 303 && /\/book\/manage\?/.test(bk1.location) && !!flash(bk1.location).ok, "A 預約 10:00 → 成功（管理頁）", flash(bk1.location).ok ?? flash(bk1.location).err);
const bk2 = await post(`/s/${slug}/api/booking/book`, { serviceId: svc.id, startsAt: slot.start, name: "李大華", email: emailB, phone: "0912000222" }, cookieB);
check(/無法預約|預約走了/.test(flash(bk2.location).err ?? ""), "B 預約同一時段 → 被拒", flash(bk2.location).err ?? bk2.location);
const bk3 = await post(`/s/${slug}/api/booking/book`, { serviceId: svc.id, startsAt: new Date(new Date(slot.start).getTime() + 3600_000).toISOString(), name: "李大華", email: emailB, phone: "0912000222" }, cookieB);
check(/無法預約/.test(flash(bk3.location).err ?? ""), "B 預約 11:00（在 A 的緩衝內）→ 被拒", flash(bk3.location).err ?? "");
const mu = new URL(bk1.location, base);
const ics = await get(`/s/${slug}/book/ics?b=${mu.searchParams.get("b")}&t=${encodeURIComponent(mu.searchParams.get("t"))}`);
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
check(ics.status === 200 && /text\/calendar/.test(ics.type) && ics.body.includes(`DTSTART:${stamp(slot.start)}`) && ics.body.includes(`DTEND:${stamp(new Date(new Date(slot.start).getTime() + 3600_000))}`) && ics.body.includes("LOCATION:台北市測試路 9 號") && ics.body.includes("\r\n"), ".ics 正確（DTSTART/DTEND UTC、地點、CRLF）", ics.body.split("\r\n").filter((l) => /^DT(START|END)/.test(l)).join(" "));
const badIcs = await get(`/s/${slug}/book/ics?b=${mu.searchParams.get("b")}&t=${"x".repeat(32)}`);
check(badIcs.status === 404, ".ics 簽章錯誤 → 404");
const lb = await site.call("list_bookings", {});
check(lb.bookings?.length === 1 && lb.bookings[0].status === "confirmed" && lb.bookings[0].contact.email.includes("＊"), "list_bookings：1 筆已確認、聯絡資料遮罩", lb.__error ?? JSON.stringify(lb.bookings?.[0]));
const acctA = await get(`/s/${slug}/account`, cookieA);
check(acctA.body.includes("我的預約") && acctA.body.includes("一對一諮詢"), "A 的會員中心：我的預約");

/* ---------------------------------------------------------------- courses */
const ecr = await site.call("enable_module", { moduleId: "courses" });
check(ecr.changed?.some((c) => c.id === "courses" && c.status === "enabled"), "enable_module courses", ecr.__error ?? JSON.stringify(ecr.changed));
const crs = await site.call("create_course", { slug: "tarot", title: `E2E 塔羅入門 ${ts}`, price: 1800, summary: "從零開始" });
check(crs.id && crs.status === "draft", "create_course（NT$1800 草稿）", crs.__error ?? "");
const PAID_ID = `PAID${ts}`.replace(/[^A-Za-z0-9]/g, "").padEnd(11, "x").slice(0, 11);
const l1 = await site.call("add_lesson", { courseSlug: "tarot", slug: "intro", title: "第一課（試看）", videoUrl: "https://youtu.be/FREEvid0001", isPreview: true, bodyMd: "歡迎" });
const l2 = await site.call("add_lesson", { courseSlug: "tarot", slug: "major", title: "大阿爾克那", videoUrl: `https://www.youtube.com/watch?v=${PAID_ID}`, bodyMd: "付費內容 SECRET-BODY", attachments: [{ name: "講義", url: "https://example.com/e2e-handout.pdf" }] });
check(l1.id && l2.videoEmbed === `https://www.youtube-nocookie.com/embed/${PAID_ID}`, "add_lesson ×2（試看＋付費，影片轉 embed）", l2.__error ?? l2.videoEmbed);
const badVid = await site.call("add_lesson", { courseSlug: "tarot", slug: "bad", title: "x", videoUrl: "https://evil.example/v.mp4" });
check(badVid.__error?.startsWith("[invalid]"), "白名單以外的影片網址被拒");
const pubC = await site.call("update_course", { slug: "tarot", patch: { status: "published" }, confirm: true });
check(pubC.status === "published", "update_course 上架（confirm）", pubC.__error ?? "");
const buyC = await post(`/s/${slug}/api/courses/buy`, { courseId: crs.id, name: "王小明", phone: "0912000111", paymentMethod: "offline" }, cookieA);
check(buyC.status === 303 && /\/orders\/CLS-/.test(buyC.location), "A 購買課程（線下匯款）→ 訂單頁", buyC.location.slice(0, 80) || flash(buyC.location).err);
const orderNoC = decodeURIComponent(/\/orders\/([^?]+)/.exec(buyC.location)?.[1] ?? "");
const lockedPage = await get(`/s/${slug}/learn/tarot/major`, cookieA);
check(lockedPage.status === 200 && lockedPage.body.includes('data-gb="locked"'), "未付款：付費單元顯示鎖定");
check(!lockedPage.body.includes(PAID_ID) && !lockedPage.body.includes("SECRET-BODY") && !lockedPage.body.includes("e2e-handout.pdf"), "未付款：HTML 不含付費影片網址、內容、附件");
const detailPage = await get(`/s/${slug}/courses/tarot`, cookieA);
check(detailPage.status === 200 && !detailPage.body.includes(PAID_ID), "課程介紹頁 HTML 不含付費影片網址");
const previewPage = await get(`/s/${slug}/learn/tarot/intro`);
check(previewPage.body.includes("youtube-nocookie.com/embed/FREEvid0001"), "試看單元：未登入也看得到影片");
const paidC = await site.call("mark_order_paid", { orderNo: orderNoC, confirm: true });
check(paidC.status === "paid", "mark_order_paid（課程）", paidC.__error ?? "");
const acctC = await get(`/s/${slug}/account`, cookieA);
check(acctC.body.includes("我的課程") && acctC.body.includes(`E2E 塔羅入門 ${ts}`) && acctC.body.includes('data-gb="my-course-link"'), "會員中心看得到課程");
const openPage = await get(`/s/${slug}/learn/tarot/major`, cookieA);
check(openPage.body.includes(`youtube-nocookie.com/embed/${PAID_ID}`) && openPage.body.includes("SECRET-BODY") && openPage.body.includes('data-gb="mark-done"'), "付款後可以上課（影片、內容、標記完成）");
const markDone = await post(`/s/${slug}/api/courses/progress`, { course: "tarot", lesson: "major" }, cookieA);
check(/已標記完成/.test(flash(markDone.location).ok ?? ""), "標記完成", flash(markDone.location).ok ?? flash(markDone.location).err);
const otherPage = await get(`/s/${slug}/learn/tarot/major`, cookieB);
check(!otherPage.body.includes(PAID_ID), "沒買的 B 仍看不到付費影片網址");
const enr = await site.call("list_enrollments", { courseSlug: "tarot" });
check(enr.enrollments?.length === 1 && enr.enrollments[0].source === "order" && enr.enrollments[0].lessonsCompleted === 1 && enr.enrollments[0].member.includes("＊"), "list_enrollments：1 位（訂單開通、完成 1、email 遮罩）", enr.__error ?? JSON.stringify(enr.enrollments?.[0]));

await site.close();
done();
