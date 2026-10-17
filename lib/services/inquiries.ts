import { createHmac } from "node:crypto";
import { z } from "zod";
import { getModule } from "@/modules/registry";
import type { Store } from "../store/types";
import { ServiceError, activeModuleIds, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";

export function hashIp(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(`ip:${ip}`).digest("hex").slice(0, 32);
}

export const inquiryInput = z.object({
  name: z.string().trim().min(1, "請填寫姓名").max(80),
  email: z.email({ message: "Email 格式不正確" }).max(200),
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().min(1, "請填寫留言").max(4000),
  path: z.string().max(200).optional(),
  /** honeypot：真人看不到這個欄位，有值就是機器人 */
  website: z.string().max(500).optional(),
});

const DEFAULT_LIMIT_PER_HOUR = 5;
export const LINE_CLICK_LIMIT_PER_10MIN = 30;

/**
 * 前台聯絡表單送出（公開入口，無 token）。
 * - honeypot 有值：回成功但不寫入（不讓機器人知道被擋）
 * - 每 IP 每小時上限（DB 計數，跨 serverless 實例有效）
 * - 有 RESEND_API_KEY 且模組設定了 notifyEmail 才寄通知信；寄信失敗不影響送出
 */
export async function submitInquiry(
  deps: { store: Store; ipSecret: string; sendMail?: (to: string, subject: string, text: string) => Promise<void> },
  input: { slug: string; ip: string; data: unknown },
): Promise<{ stored: boolean }> {
  const tenant = await deps.store.getTenantBySlug(input.slug);
  if (!tenant || tenant.status === "suspended") throw new ServiceError("not_found", "找不到網站");
  const states = await moduleStates(deps, tenant.id);
  if (!activeModuleIds(states).has("contact-form")) throw new ServiceError("forbidden", "此網站未啟用聯絡表單");

  const parsed = inquiryInput.safeParse(input.data);
  if (!parsed.success) throw new ServiceError("invalid", parsed.error.issues.map((i) => i.message).join("；"));
  const d = parsed.data;
  if (d.website && d.website.trim() !== "") return { stored: false };

  // 模組設定讀「已發布」快照（configure_module 只改草稿，發布後才生效）
  let published: Record<string, unknown> = {};
  if (tenant.published_revision_id) {
    const rev = await deps.store.getRevision(tenant.published_revision_id);
    published = rev?.content.moduleSettings?.["contact-form"] ?? {};
  }
  const config = getModule("contact-form")!.settingsSchema.safeParse(published);
  const cfg = (config.success ? config.data : {}) as { notifyEmail?: string; rateLimitPerHour?: number };
  const ipHash = hashIp(input.ip || "unknown", deps.ipSecret);
  // 原子計數（DB 端 insert … on conflict … returning），併發送出也無法繞過；被擋的不寫入、不寄信
  const hit = await deps.store.rateHit(`inquiry:${tenant.id}`, ipHash, 3600, cfg.rateLimitPerHour ?? DEFAULT_LIMIT_PER_HOUR);
  if (!hit.allowed) throw new ServiceError("rate_limited", "送出太頻繁，請稍後再試");

  await deps.store.insertInquiry({
    tenant_id: tenant.id,
    name: d.name,
    email: d.email,
    phone: d.phone || null,
    message: d.message,
    source_path: d.path ?? null,
    ip_hash: ipHash,
  });

  if (cfg.notifyEmail && deps.sendMail) {
    try {
      await deps.sendMail(
        cfg.notifyEmail,
        `【${tenant.name}】新的網站詢問：${d.name}`,
        `姓名：${d.name}\nEmail：${d.email}\n電話：${d.phone ?? "-"}\n頁面：${d.path ?? "-"}\n\n${d.message}`,
      );
    } catch (e) {
      console.error("[inquiry] notify mail failed", e instanceof Error ? e.message : e);
    }
  }
  return { stored: true };
}

export async function listInquiries(ctx: ServiceContext, input: { site?: string | null; limit?: number; status?: "new" | "read" | "archived" }) {
  requireScope(ctx, "inquiries:read");
  const tenant = await resolveTenant(ctx, input.site);
  const rows = await ctx.store.listInquiries(tenant.id, { limit: Math.max(1, Math.min(100, input.limit ?? 20)), status: input.status });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    message: r.message,
    page: r.source_path,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function recordLineClick(
  deps: { store: Store; ipSecret: string },
  input: { slug: string; ip: string; path?: string; placement?: string; userAgent?: string | null },
) {
  const tenant = await deps.store.getTenantBySlug(input.slug);
  if (!tenant) throw new ServiceError("not_found", "找不到網站");
  const active = activeModuleIds(await moduleStates(deps, tenant.id));
  if (!active.has("line")) throw new ServiceError("forbidden", "此網站未啟用 LINE 模組");
  const ipHash = hashIp(input.ip || "unknown", deps.ipSecret);
  const hit = await deps.store.rateHit(`line:${tenant.id}`, ipHash, 600, LINE_CLICK_LIMIT_PER_10MIN);
  if (!hit.allowed) throw new ServiceError("rate_limited", "點擊紀錄太頻繁");
  await deps.store.insertLineClick({
    tenant_id: tenant.id,
    path: input.path?.slice(0, 200) ?? null,
    placement: input.placement === "floating" ? "floating" : "section",
    ip_hash: ipHash,
    user_agent: input.userAgent?.slice(0, 300) ?? null,
  });
}
