import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { BroadcastRow, Store, TenantRow } from "../store/types";

import { isReservedTestAddress, sendMailWithId } from "../mail";
import { hashIp } from "./inquiries";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { publishedModuleSettings, emailSchema } from "./members";
import { parse } from "./sites";
import { normalizeEmail } from "../email-normalize";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const CONFIRM_TTL_MS = 48 * 3600_000;
/** 每次 send_broadcast 呼叫最多寄幾封（serverless 執行時間有限；剩下的再呼叫一次會接續） */
export const BATCH_SIZE = 50;
/** 宣告超過這麼久仍是 sending（行程被砍）→ 標 failed，不重寄 */
export const STALE_CLAIM_MS = 15 * 60_000;
/**
 * 🔴 測試租戶（is_test）群發時，只會真的寄給這個名單；其他收件人一律記為 skipped（不寄給真實的人）。
 */
export const TEST_TENANT_ALLOWLIST = ["gathertaiwan@gmail.com"];

export type SendWithId = (to: string, subject: string, text: string, headers?: Record<string, string>) => Promise<{ id: string | null; skipped: boolean }>;
export interface NewsletterDeps {
  store: Store;
  baseUrl: string;
  ipSecret: string;
  /** 沒設 RESEND_API_KEY 時為 undefined */
  send?: SendWithId;
}

export function defaultSender(): SendWithId | undefined {
  return process.env.RESEND_API_KEY ? sendMailWithId : undefined;
}

async function newsletterActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("newsletter");
}
function siteUrl(baseUrl: string, tenant: TenantRow, path: string) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}${path}`;
}

/** 退訂 token：HMAC(secret, broadcastId:subscriberId)。DB 只存 sha256；寄信時重算原文放進連結。 */
export function unsubToken(secret: string, broadcastId: string, subscriberId: string) {
  return createHmac("sha256", secret).update(`unsub:${broadcastId}:${subscriberId}`).digest("base64url");
}

/* ================================================================== 公開：訂閱／確認／退訂 */

export const SUBSCRIBE_DONE = "請到信箱點確認連結，完成訂閱。";
/** H-2：同一網站同一信箱 24 小時內最多寄 1 封確認信 */
export const CONFIRM_PER_EMAIL_PER_DAY = 1;
/** H-2：跨所有網站，同一信箱（正規化後）24 小時內最多 3 封確認信——避免開很多租戶一起轟炸同一人 */
export const CONFIRM_GLOBAL_PER_EMAIL_PER_DAY = 3;

/**
 * 訂閱（公開、無登入）。不論 email 是否已訂閱都回同一句話（不洩漏名單）；honeypot、每 IP 限流。
 * 已確認的不重寄；未確認／已退訂的寄一封新的確認信（舊連結失效）。
 */
export async function subscribe(deps: NewsletterDeps, input: { slug: string; ip: string; email?: unknown; website?: unknown }): Promise<{ message: string; sent: boolean }> {
  const tenant = await deps.store.getTenantBySlug(input.slug);
  if (!tenant || tenant.status === "suspended") throw new ServiceError("not_found", "找不到網站");
  if (!(await newsletterActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放電子報訂閱");
  if (typeof input.website === "string" && input.website.trim()) return { message: SUBSCRIBE_DONE, sent: false };
  const email = parse(emailSchema, input.email);
  const cfg = (await publishedModuleSettings(deps.store, tenant, "newsletter")) as { rateLimitPerHour?: number };
  const hit = await deps.store.rateHit(`newsletter:${tenant.id}`, hashIp(input.ip || "unknown", deps.ipSecret), 3600, cfg.rateLimitPerHour ?? 5);
  if (!hit.allowed) throw new ServiceError("rate_limited", "送出太頻繁，請稍後再試");
  // H-2：每個信箱的確認信冷卻（站內 24h 1 封、跨站 24h 3 封）。被擋時回同一句話、不換 token（之前寄出的連結仍有效）
  const ek = sha256(`nl:${normalizeEmail(email)}`);
  const perSite = await deps.store.rateHit(`newsletter-confirm:${tenant.id}`, ek, 86_400, CONFIRM_PER_EMAIL_PER_DAY);
  if (!perSite.allowed) return { message: SUBSCRIBE_DONE, sent: false };
  const global = await deps.store.rateHit("newsletter-confirm-global", ek, 86_400, CONFIRM_GLOBAL_PER_EMAIL_PER_DAY);
  if (!global.allowed) return { message: SUBSCRIBE_DONE, sent: false };
  const raw = randomBytes(32).toString("base64url");
  const r = await deps.store.upsertPendingSubscriber({ tenant_id: tenant.id, email, confirm_token_hash: sha256(raw), confirm_expires_at: new Date(Date.now() + CONFIRM_TTL_MS).toISOString() });
  if (!r.needsConfirm) return { message: SUBSCRIBE_DONE, sent: false };
  const text = `你好，\n\n請點下面的連結確認訂閱「${tenant.name}」電子報（48 小時內有效）：\n${siteUrl(deps.baseUrl, tenant, `/newsletter/confirm?token=${raw}`)}\n\n如果不是你本人申請，請忽略這封信，不會收到任何電子報。`;
  if (!deps.send) {
    console.log(`[newsletter] RESEND_API_KEY 未設定，未寄出確認信給 ${email.replace(/(.{2}).*@/, "$1***@")}`);
    return { message: SUBSCRIBE_DONE, sent: false };
  }
  try {
    await deps.send(email, `【${tenant.name}】請確認訂閱電子報`, text);
  } catch (e) {
    console.error("[newsletter] 確認信寄送失敗", e instanceof Error ? e.message : e);
  }
  return { message: SUBSCRIBE_DONE, sent: true };
}

export async function confirmSubscription(store: Store, tenant: TenantRow, token: unknown): Promise<{ ok: boolean; message: string }> {
  const raw = typeof token === "string" ? token : "";
  if (raw.length < 20 || raw.length > 200) return { ok: false, message: "確認連結無效或已過期，請重新訂閱。" };
  const s = await store.confirmSubscriber(tenant.id, sha256(raw), new Date().toISOString());
  return s ? { ok: true, message: "訂閱完成，謝謝！" } : { ok: false, message: "確認連結無效或已過期，請重新訂閱。" };
}

/** 退訂：token 一次性（unsub_used_at 條件更新），退訂後不再寄 */
export async function unsubscribe(store: Store, tenant: TenantRow, token: unknown): Promise<{ ok: boolean; message: string }> {
  const raw = typeof token === "string" ? token : "";
  if (raw.length < 20 || raw.length > 200) return { ok: false, message: "退訂連結無效或已使用。" };
  const d = await store.consumeUnsubToken(tenant.id, sha256(raw));
  if (!d) return { ok: false, message: "退訂連結無效或已使用。" };
  await store.unsubscribeSubscriber(tenant.id, d.subscriber_id);
  await store.insertAudit({ tenant_id: tenant.id, actor: "subscriber", action: "newsletter.unsubscribe", payload: { subscriberId: d.subscriber_id, broadcastId: d.broadcast_id } });
  return { ok: true, message: "已取消訂閱，之後不會再收到電子報。" };
}

/* ================================================================== 群發（MCP／後台） */

async function requireNewsletter(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await newsletterActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「newsletter」，請先 enable_module newsletter");
}

const broadcastInput = z
  .object({
    subject: z.string().trim().min(1).max(150),
    bodyMd: z.string().trim().min(1).max(50_000),
  })
  .strict();

function broadcastSummary(b: BroadcastRow, stats?: Record<string, number>) {
  return { id: b.id, subject: b.subject, status: b.status, testSentAt: b.test_sent_at, startedAt: b.started_at, finishedAt: b.finished_at, sentCount: b.sent_count, failedCount: b.failed_count, stats, createdAt: b.created_at };
}

/** Markdown → 純文字信件（保留段落與連結網址，不輸出 HTML） */
export function mdToText(md: string) {
  return md
    .replace(/\r/g, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function composeMail(tenant: TenantRow, b: BroadcastRow, footer: string | undefined, unsubUrl: string | null) {
  const text = `${mdToText(b.body_md)}\n\n——\n${footer ?? tenant.name}${unsubUrl ? `\n不想再收到電子報？取消訂閱：${unsubUrl}` : "\n（這是測試信）"}`;
  return { subject: b.subject, text };
}

export async function createBroadcast(ctx: ServiceContext, input: { site?: string | null; subject: string; bodyMd: string }) {
  requireScope(ctx, "newsletter:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireNewsletter(ctx, tenant);
  const d = parse(broadcastInput, { subject: input.subject, bodyMd: input.bodyMd });
  const b = await ctx.store.insertBroadcast({ tenant_id: tenant.id, subject: d.subject, body_md: d.bodyMd });
  await audit(ctx, tenant.id, "newsletter.create", { broadcastId: b.id });
  return { ...broadcastSummary(b), note: "草稿已建立。建議先 send_test_broadcast 寄一封到自己的信箱確認，再 send_broadcast（confirm: true）群發。" };
}

/** 寄測試信：只寄到指定的一個信箱（不會寄給任何訂閱者），退訂連結以「測試信」字樣代替 */
export async function sendTestBroadcast(ctx: ServiceContext, input: { site?: string | null; broadcastId: string; to: string }, send: SendWithId | undefined = defaultSender()) {
  requireScope(ctx, "newsletter:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireNewsletter(ctx, tenant);
  const b = await ctx.store.getBroadcast(tenant.id, input.broadcastId);
  if (!b) throw new ServiceError("not_found", "找不到這份電子報");
  const to = parse(emailSchema, input.to);
  if (tenant.is_test && !TEST_TENANT_ALLOWLIST.includes(to) && !isReservedTestAddress(to)) throw new ServiceError("forbidden", `測試租戶的測試信只能寄到 ${TEST_TENANT_ALLOWLIST.join("、")}`);
  if (!send) throw new ServiceError("invalid", "寄信服務尚未設定（RESEND_API_KEY），無法寄出");
  const footer = ((await publishedModuleSettings(ctx.store, tenant, "newsletter")) as { footer?: string }).footer;
  const m = composeMail(tenant, b, footer, null);
  const r = await send(to, `［測試］${m.subject}`, m.text);
  await ctx.store.updateBroadcast(tenant.id, b.id, ["draft", "sending", "sent"], { test_sent_at: new Date().toISOString() });
  await audit(ctx, tenant.id, "newsletter.test", { broadcastId: b.id, providerId: r.id, skipped: r.skipped });
  return { sent: !r.skipped, to, providerMessageId: r.id, note: r.skipped ? "測試保留網域，未實際寄出" : "測試信已寄出" };
}

/**
 * 群發（confirm: true）：draft → sending 為條件式轉換（同一份只能開始一次；sent 之後再呼叫一律拒絕）。
 * 只寄給「已確認且未退訂」的訂閱者；每封寄送列唯一（broadcast+subscriber），分批寄、逐封記錄結果；
 * 一次最多寄 BATCH_SIZE 封，還有剩下時狀態維持 sending，再呼叫一次 send_broadcast 會接續（不會重寄）。
 */
export async function sendBroadcast(ctx: ServiceContext, input: { site?: string | null; broadcastId: string; confirm?: boolean }, send: SendWithId | undefined = defaultSender()) {
  requireScope(ctx, "newsletter:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireNewsletter(ctx, tenant);
  const b = await ctx.store.getBroadcast(tenant.id, input.broadcastId);
  if (!b) throw new ServiceError("not_found", "找不到這份電子報");
  if (b.status === "sent") throw new ServiceError("conflict", "這份電子報已經群發過了，不能重複群發（請建立新的一份）");
  if (!send) throw new ServiceError("invalid", "寄信服務尚未設定（RESEND_API_KEY），無法群發");
  const confirmed = (await ctx.store.listSubscribers(tenant.id, { status: "confirmed", limit: 1, offset: 0 })).total;
  if (input.confirm !== true) throw new ServiceError("confirm_required", `群發「${b.subject}」給 ${confirmed} 位已確認的訂閱者，寄出後無法收回。請先讓使用者確認，再以 confirm: true 呼叫。`);
  let cur = b;
  if (b.status === "draft") {
    const started = await ctx.store.updateBroadcast(tenant.id, b.id, ["draft"], { status: "sending", started_at: new Date().toISOString() });
    if (!started) throw new ServiceError("conflict", "這份電子報已經開始群發（可能是另一個請求），請用 list_broadcasts 查看進度");
    cur = started;
    await ctx.store.queueDeliveries(tenant.id, b.id, (sid) => sha256(unsubToken(ctx.previewSecret, b.id, sid)));
    await audit(ctx, tenant.id, "newsletter.send_start", { broadcastId: b.id, recipients: confirmed });
  }
  const footer = ((await publishedModuleSettings(ctx.store, tenant, "newsletter")) as { footer?: string }).footer;
  // M-1：先把「宣告後中斷」的列標 failed（不重寄），再原子宣告自己這一批（併發呼叫拿到的列不重疊）
  await ctx.store.failStaleDeliveries(tenant.id, b.id, new Date(Date.now() - STALE_CLAIM_MS).toISOString());
  const batch = await ctx.store.claimDeliveries(tenant.id, b.id, BATCH_SIZE);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const d of batch) {
    // 寄出前再確認一次：期間退訂的不寄
    const sub = await ctx.store.getSubscriberById(tenant.id, d.subscriber_id);
    if (!sub || sub.status !== "confirmed") {
      if (await ctx.store.finishDelivery(tenant.id, d.id, { status: "skipped", error: "已退訂或未確認", sent_at: null })) skipped++;
      continue;
    }
    if (tenant.is_test && !TEST_TENANT_ALLOWLIST.includes(d.email)) {
      if (await ctx.store.finishDelivery(tenant.id, d.id, { status: "skipped", error: "測試租戶：不寄給白名單以外的收件人", sent_at: null })) skipped++;
      continue;
    }
    const unsubUrl = siteUrl(ctx.baseUrl, tenant, `/newsletter/unsubscribe?t=${unsubToken(ctx.previewSecret, b.id, d.subscriber_id)}`);
    const m = composeMail(tenant, cur, footer, unsubUrl);
    try {
      const r = await send(d.email, m.subject, m.text, { "List-Unsubscribe": `<${unsubUrl}>` });
      if (await ctx.store.finishDelivery(tenant.id, d.id, r.skipped ? { status: "skipped", error: "測試保留網域", sent_at: null } : { status: "sent", error: null, sent_at: new Date().toISOString() })) {
        if (r.skipped) skipped++;
        else sent++;
      }
    } catch (e) {
      if (await ctx.store.finishDelivery(tenant.id, d.id, { status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300), sent_at: null })) failed++;
    }
  }
  const stats = await ctx.store.deliveryStats(tenant.id, b.id);
  const done = stats.queued === 0 && stats.sending === 0;
  const after = await ctx.store.updateBroadcast(tenant.id, b.id, ["sending"], { sent_count: stats.sent, failed_count: stats.failed, ...(done ? { status: "sent", finished_at: new Date().toISOString() } : {}) });
  await audit(ctx, tenant.id, done ? "newsletter.send_done" : "newsletter.send_batch", { broadcastId: b.id, sent, failed, skipped, remaining: stats.queued, sending: stats.sending });
  return { ...broadcastSummary(after ?? cur, stats), thisBatch: { sent, failed, skipped }, remaining: stats.queued + stats.sending, note: done ? "群發完成。" : stats.queued ? `還有 ${stats.queued} 封待寄，請再呼叫一次 send_broadcast（confirm: true）接續。` : `另一個群發呼叫正在寄送 ${stats.sending} 封，請稍後用 list_broadcasts 查看。` };
}

export async function listBroadcasts(ctx: ServiceContext, input: { site?: string | null; limit?: number }) {
  requireScope(ctx, "newsletter:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireNewsletter(ctx, tenant);
  const rows = await ctx.store.listBroadcasts(tenant.id, Math.max(1, Math.min(50, input.limit ?? 20)));
  return { broadcasts: await Promise.all(rows.map(async (b) => broadcastSummary(b, b.status === "draft" ? undefined : await ctx.store.deliveryStats(tenant.id, b.id)))) };
}

export async function listSubscribers(ctx: ServiceContext, input: { site?: string | null; status?: "pending" | "confirmed" | "unsubscribed"; limit?: number; offset?: number }) {
  requireScope(ctx, "newsletter:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireNewsletter(ctx, tenant);
  const [r, c, p, u] = await Promise.all([
    ctx.store.listSubscribers(tenant.id, { status: input.status, limit: Math.max(1, Math.min(200, input.limit ?? 50)), offset: Math.max(0, input.offset ?? 0) }),
    ctx.store.listSubscribers(tenant.id, { status: "confirmed", limit: 1, offset: 0 }),
    ctx.store.listSubscribers(tenant.id, { status: "pending", limit: 1, offset: 0 }),
    ctx.store.listSubscribers(tenant.id, { status: "unsubscribed", limit: 1, offset: 0 }),
  ]);
  return {
    counts: { confirmed: c.total, pending: p.total, unsubscribed: u.total },
    total: r.total,
    subscribers: r.rows.map((s) => ({ id: s.id, email: s.email, status: s.status, confirmedAt: s.confirmed_at, unsubscribedAt: s.unsubscribed_at, createdAt: s.created_at })),
  };
}

