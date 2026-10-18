/**
 * newsletter 模組：雙重確認、退訂 token 一次性、群發只寄已確認未退訂、同一份不能重複群發、分批接續不重寄、測試租戶白名單。
 * 🔴 全部用假的寄信函式（記錄收件人），不寄出任何真信。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { publishSite } from "@/lib/services/publish";
import { BATCH_SIZE, confirmSubscription, createBroadcast, listSubscribers, sendBroadcast, sendTestBroadcast, subscribe, unsubscribe, type SendWithId } from "@/lib/services/newsletter";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
});

function mailbox() {
  const sent: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
  const send: SendWithId = async (to, subject, text, headers) => {
    sent.push({ to, subject, text, headers });
    return { id: `msg_${sent.length}`, skipped: false };
  };
  return { sent, send };
}

async function nlSite(store: Store, slug: string, test = false) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: `電子報 ${slug}`, modules: ["newsletter"], test });
  await publishSite(ctx, { site: slug, confirm: true }).catch(() => undefined);
  return { ctx, tenant: (await store.getTenantBySlug(slug))! };
}

const tokenFrom = (text: string, key: string) => new RegExp(`${key}=([A-Za-z0-9_-]+)`).exec(text)![1]!;

async function subscribeAndConfirm(store: Store, slug: string, email: string, ip = "1.1.1.1") {
  const mb = mailbox();
  await subscribe({ store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send }, { slug, ip, email });
  const t = (await store.getTenantBySlug(slug))!;
  return confirmSubscription(store, t, tokenFrom(mb.sent[0]!.text, "token"));
}

describe("雙重確認", () => {
  it("訂閱 → 待確認 → 確認連結一次性；已確認者重複訂閱不再寄信；回應不洩漏名單", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-confirm");
    const mb = mailbox();
    const deps = { store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send };
    const r1 = await subscribe(deps, { slug: "nl-confirm", ip: "1.1.1.1", email: "Fan@Example.com" });
    expect(mb.sent).toHaveLength(1);
    expect(mb.sent[0]!.to).toBe("fan@example.com");
    expect((await listSubscribers(s.ctx, { site: "nl-confirm" })).counts).toEqual({ confirmed: 0, pending: 1, unsubscribed: 0 });
    const tok = tokenFrom(mb.sent[0]!.text, "token");
    expect((await confirmSubscription(store, s.tenant, tok)).ok).toBe(true);
    expect((await confirmSubscription(store, s.tenant, tok)).ok).toBe(false); // 一次性
    const r2 = await subscribe(deps, { slug: "nl-confirm", ip: "1.1.1.1", email: "fan@example.com" });
    expect(r2.message).toBe(r1.message);
    expect(mb.sent).toHaveLength(1); // 已確認不重寄
    // honeypot：不寫入、同一句話
    await subscribe(deps, { slug: "nl-confirm", ip: "1.1.1.1", email: "bot@example.com", website: "spam" });
    expect((await listSubscribers(s.ctx, { site: "nl-confirm" })).counts.pending).toBe(0);
  });

  it("確認連結過期無效；別站的 token 無效；每 IP 限流", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-expire");
    const other = await nlSite(store, "nl-other");
    const mb = mailbox();
    const deps = { store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mb.send };
    await subscribe(deps, { slug: "nl-expire", ip: "2.2.2.2", email: "a@example.com" });
    const tok = tokenFrom(mb.sent[0]!.text, "token");
    expect((await confirmSubscription(store, other.tenant, tok)).ok).toBe(false);
    // 模擬過期：時間往後 49 小時（確認連結 48 小時有效）
    vi.useFakeTimers({ now: Date.now() + 49 * 3600_000, toFake: ["Date"] });
    try {
      expect((await confirmSubscription(store, s.tenant, tok)).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    for (let i = 0; i < 4; i++) await subscribe(deps, { slug: "nl-expire", ip: "3.3.3.3", email: `r${i}@example.com` });
    await subscribe(deps, { slug: "nl-expire", ip: "3.3.3.3", email: "r5@example.com" });
    await expect(subscribe(deps, { slug: "nl-expire", ip: "3.3.3.3", email: "r6@example.com" })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("群發", () => {
  it("只寄已確認且未退訂；退訂 token 一次性且退訂後不再寄；同一份不能重複群發", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-send");
    await subscribeAndConfirm(store, "nl-send", "c1@example.org");
    await subscribeAndConfirm(store, "nl-send", "c2@example.org");
    await subscribe({ store, baseUrl: "http://t", ipSecret: "ip-secret-xxxx", send: mailbox().send }, { slug: "nl-send", ip: "9.9.9.9", email: "pending@example.org" });
    const b = await createBroadcast(s.ctx, { site: "nl-send", subject: "十月新品", bodyMd: "# 新品\n\n**限時** 優惠 [看看](https://example.org/shop)" });
    const mb = mailbox();
    await expect(sendBroadcast(s.ctx, { site: "nl-send", broadcastId: b.id }, mb.send)).rejects.toMatchObject({ code: "confirm_required" });
    const r = await sendBroadcast(s.ctx, { site: "nl-send", broadcastId: b.id, confirm: true }, mb.send);
    expect(r.status).toBe("sent");
    expect(mb.sent.map((m) => m.to).sort()).toEqual(["c1@example.org", "c2@example.org"]);
    expect(mb.sent[0]!.text).toContain("限時 優惠 看看（https://example.org/shop）");
    expect(mb.sent[0]!.headers?.["List-Unsubscribe"]).toMatch(/\/newsletter\/unsubscribe\?t=/);
    await expect(sendBroadcast(s.ctx, { site: "nl-send", broadcastId: b.id, confirm: true }, mb.send)).rejects.toMatchObject({ code: "conflict" });

    // 退訂：一次性
    const c1 = mb.sent.find((m) => m.to === "c1@example.org")!;
    const t = tokenFrom(c1.text, "t");
    expect((await unsubscribe(store, s.tenant, t)).ok).toBe(true);
    expect((await unsubscribe(store, s.tenant, t)).ok).toBe(false);
    // 下一份不會寄給已退訂的人
    const b2 = await createBroadcast(s.ctx, { site: "nl-send", subject: "十一月", bodyMd: "hi" });
    const mb2 = mailbox();
    await sendBroadcast(s.ctx, { site: "nl-send", broadcastId: b2.id, confirm: true }, mb2.send);
    expect(mb2.sent.map((m) => m.to)).toEqual(["c2@example.org"]);
  });

  it("併發開始群發只會有一個成功；分批接續不重寄", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-batch");
    for (let i = 0; i < BATCH_SIZE + 5; i++) await store.upsertPendingSubscriber({ tenant_id: s.tenant.id, email: `u${i}@example.org`, confirm_token_hash: `h${i}`, confirm_expires_at: new Date(Date.now() + 60_000).toISOString() });
    for (let i = 0; i < BATCH_SIZE + 5; i++) await store.confirmSubscriber(s.tenant.id, `h${i}`, new Date().toISOString());
    const b = await createBroadcast(s.ctx, { site: "nl-batch", subject: "大量", bodyMd: "內容" });
    const mb = mailbox();
    const both = await Promise.allSettled([sendBroadcast(s.ctx, { site: "nl-batch", broadcastId: b.id, confirm: true }, mb.send), sendBroadcast(s.ctx, { site: "nl-batch", broadcastId: b.id, confirm: true }, mb.send)]);
    expect(both.filter((x) => x.status === "rejected")).toHaveLength(1);
    const first = (both.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof sendBroadcast>>>).value;
    expect(first.remaining).toBe(5);
    const second = await sendBroadcast(s.ctx, { site: "nl-batch", broadcastId: b.id, confirm: true }, mb.send);
    expect(second.remaining).toBe(0);
    expect(second.status).toBe("sent");
    expect(mb.sent).toHaveLength(BATCH_SIZE + 5);
    expect(new Set(mb.sent.map((m) => m.to)).size).toBe(BATCH_SIZE + 5);
  });

  it("測試信只寄指定信箱；測試租戶群發只寄白名單（gathertaiwan@gmail.com）", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-test", true);
    await subscribeAndConfirm(store, "nl-test", "gathertaiwan@gmail.com");
    await subscribeAndConfirm(store, "nl-test", "someone-real@gmail.com", "5.5.5.5");
    const b = await createBroadcast(s.ctx, { site: "nl-test", subject: "測試", bodyMd: "內容" });
    const mb = mailbox();
    await expect(sendTestBroadcast(s.ctx, { site: "nl-test", broadcastId: b.id, to: "someone-real@gmail.com" }, mb.send)).rejects.toMatchObject({ code: "forbidden" });
    const t = await sendTestBroadcast(s.ctx, { site: "nl-test", broadcastId: b.id, to: "gathertaiwan@gmail.com" }, mb.send);
    expect(t).toMatchObject({ sent: true, to: "gathertaiwan@gmail.com" });
    expect(mb.sent).toHaveLength(1);
    expect(mb.sent[0]!.subject).toMatch(/^［測試］/);
    const r = await sendBroadcast(s.ctx, { site: "nl-test", broadcastId: b.id, confirm: true }, mb.send);
    expect(mb.sent.map((m) => m.to)).toEqual(["gathertaiwan@gmail.com", "gathertaiwan@gmail.com"]);
    expect(r.stats).toMatchObject({ sent: 1, skipped: 1 });
  });

  it("需要 newsletter:write；讀訂閱者需要 newsletter:read", async () => {
    const store = newStore();
    const s = await nlSite(store, "nl-scope");
    const tok = ctxFor(store, { kind: "token", label: "t", tenantId: s.tenant.id, scopes: ["site:read", "content:write"] });
    await expect(createBroadcast(tok, { subject: "x", bodyMd: "y" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listSubscribers(tok, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
