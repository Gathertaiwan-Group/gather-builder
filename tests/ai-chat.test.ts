/**
 * ai-chat 模組：限流（每 IP 每日、每站每日；被擋不呼叫 AI）、租戶隔離（A 站對話與知識讀不到 B 站）、不得捏造價格、萃取聯絡資料。
 * 🔴 用假的 Gemini 函式，不呼叫外部 API。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, newStore } from "./helpers";
import { makeShop } from "./shop-helpers";
import { enableModule, configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { PRICE_PLACEHOLDER, chat, extractLead, sanitizePrices } from "@/lib/services/ai-chat";
import { createProduct } from "@/lib/services/shop";
import type { GeminiFn } from "@/lib/ai/gemini";
import type { Store } from "@/lib/store/types";

beforeAll(() => {
  process.env.PREVIEW_SECRET = "test-preview-secret-xxxxxxxx";
  process.env.GEMINI_API_KEY = "test-key-not-real";
});

function fakeGemini(reply = "好的，請問還有什麼需要？") {
  const calls: { system: string; turns: { role: string; text: string }[] }[] = [];
  const fn: GeminiFn = async (i) => {
    calls.push(i);
    return reply;
  };
  return { fn, calls };
}

async function aiShop(store: Store, slug: string, productName: string, cfg: Record<string, unknown> = {}) {
  const shop = await makeShop(store, slug);
  const ctx = ctxFor(store);
  await createProduct(ctx, { site: slug, slug: "special", name: productName, price: 1280, status: "published", confirm: true });
  await enableModule(ctx, { site: slug, moduleId: "ai-chat", config: { extraKnowledge: `${productName} 的專屬說明`, ...cfg } });
  await enableModule(ctx, { site: slug, moduleId: "contact-form" });
  await publishSite(ctx, { site: slug, confirm: true });
  return shop;
}

const SID = "session-abcdefghijklmnop";

describe("AI 客服", () => {
  it("限流：每 IP 每日、每站每日（DB 原子計數），被擋時不呼叫 AI", async () => {
    const store = newStore();
    await aiShop(store, "ai-rate", "限流杯", { perIpDailyLimit: 2, dailyLimit: 3 });
    const g = fakeGemini();
    const deps = { store, ipSecret: "ip-secret-xxxx", gemini: g.fn };
    await chat(deps, { slug: "ai-rate", sessionId: SID, ip: "1.1.1.1", message: "你好" });
    await chat(deps, { slug: "ai-rate", sessionId: SID, ip: "1.1.1.1", message: "在嗎" });
    await expect(chat(deps, { slug: "ai-rate", sessionId: SID, ip: "1.1.1.1", message: "第三次" })).rejects.toMatchObject({ code: "rate_limited" });
    await chat(deps, { slug: "ai-rate", sessionId: "session-zzzzzzzzzzzzzzzz", ip: "2.2.2.2", message: "別的 IP" });
    await expect(chat(deps, { slug: "ai-rate", sessionId: "session-yyyyyyyyyyyyyyyy", ip: "3.3.3.3", message: "全站上限" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(g.calls).toHaveLength(3);
  });

  it("租戶隔離：A 站的知識與對話不會出現在 B 站（即使 session id 相同）", async () => {
    const store = newStore();
    await aiShop(store, "ai-a", "阿里山烏龍");
    await aiShop(store, "ai-b", "東方美人");
    const ga = fakeGemini("A 站回覆");
    const gb = fakeGemini("B 站回覆");
    await chat({ store, ipSecret: "x-secret-xxx", gemini: ga.fn }, { slug: "ai-a", sessionId: SID, ip: "1.1.1.1", message: "A 的祕密問題" });
    await chat({ store, ipSecret: "x-secret-xxx", gemini: gb.fn }, { slug: "ai-b", sessionId: SID, ip: "1.1.1.1", message: "B 的問題" });
    expect(ga.calls[0]!.system).toContain("阿里山烏龍");
    expect(ga.calls[0]!.system).not.toContain("東方美人");
    expect(gb.calls[0]!.system).toContain("東方美人");
    expect(gb.calls[0]!.system).not.toContain("阿里山烏龍");
    expect(gb.calls[0]!.turns.map((t) => t.text)).toEqual(["B 的問題"]); // 沒有 A 的歷史
    const a = (await store.getTenantBySlug("ai-a"))!;
    const b = (await store.getTenantBySlug("ai-b"))!;
    expect((await store.getAiChat(a.id, SID))!.messages.map((m) => m.text)).toEqual(["A 的祕密問題", "A 站回覆"]);
    expect((await store.getAiChat(b.id, SID))!.messages.map((m) => m.text)).toEqual(["B 的問題", "B 站回覆"]);
    expect(await store.listAiChats(b.id, 10)).toHaveLength(1);
  });

  it("不得捏造價格：只允許商品／運費資料裡的金額，其他遮掉", async () => {
    expect(sanitizePrices("這款 NT$1280，運費 NT$80，現在特價 NT$999！大約 500 元", new Set([1280, 80]))).toEqual({
      text: `這款 NT$1280，運費 NT$80，現在特價 ${PRICE_PLACEHOLDER}！大約 ${PRICE_PLACEHOLDER}`,
      redacted: 2,
    });
    const store = newStore();
    await aiShop(store, "ai-price", "價格杯");
    const g = fakeGemini("價格杯 NT$1,280，買兩個算你 NT$2000");
    const r = await chat({ store, ipSecret: "x-secret-xxx", gemini: g.fn }, { slug: "ai-price", sessionId: SID, ip: "1.1.1.1", message: "多少錢" });
    expect(r.reply).toBe(`價格杯 NT$1,280，買兩個算你 ${PRICE_PLACEHOLDER}`);
    expect(g.calls[0]!.system).toContain("價格杯：NT$1280");
  });

  it("萃取訪客聯絡資料寫進詢問（每段對話一次）；collectLeads:false 不寫", async () => {
    expect(extractLead([{ role: "user", text: "我是陳小華，電話 0912-345-678，信箱 Hua@Example.com", at: "" }])).toEqual({ email: "hua@example.com", phone: "0912345678", name: "陳小華" });
    const store = newStore();
    const s = await aiShop(store, "ai-lead", "留言杯");
    const deps = { store, ipSecret: "x-secret-xxx", gemini: fakeGemini("已記下").fn };
    const r1 = await chat(deps, { slug: "ai-lead", sessionId: SID, ip: "1.1.1.1", message: "想訂 20 個，我是王大明 wang@example.com" });
    expect(r1.leadCaptured).toBe(true);
    const r2 = await chat(deps, { slug: "ai-lead", sessionId: SID, ip: "1.1.1.1", message: "電話 0922333444" });
    expect(r2.leadCaptured).toBe(false);
    const inq = await store.listInquiries(s.tenant.id, { limit: 10 });
    expect(inq).toHaveLength(1);
    expect(inq[0]).toMatchObject({ name: "王大明", email: "wang@example.com" });
    await configureModule(ctxFor(store), { site: "ai-lead", moduleId: "ai-chat", config: { collectLeads: false } });
    await publishSite(ctxFor(store), { site: "ai-lead", confirm: true });
    await chat(deps, { slug: "ai-lead", sessionId: "session-nolead-xxxxxxxx", ip: "1.1.1.1", message: "我的信箱 x@example.com" });
    expect(await store.listInquiries(s.tenant.id, { limit: 10 })).toHaveLength(1);
  });

  it("沒啟用模組或沒有 GEMINI_API_KEY → 拒絕；session id 格式要對", async () => {
    const store = newStore();
    await makeShop(store, "ai-off");
    await expect(chat({ store, ipSecret: "x-secret-xxx", gemini: fakeGemini().fn }, { slug: "ai-off", sessionId: SID, ip: "1", message: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    await aiShop(store, "ai-nokey", "杯");
    await expect(chat({ store, ipSecret: "x-secret-xxx", gemini: null }, { slug: "ai-nokey", sessionId: SID, ip: "1", message: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(chat({ store, ipSecret: "x-secret-xxx", gemini: fakeGemini().fn }, { slug: "ai-nokey", sessionId: "short", ip: "1", message: "hi" })).rejects.toMatchObject({ code: "invalid" });
  });
});
