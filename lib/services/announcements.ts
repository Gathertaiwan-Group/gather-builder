import { z } from "zod";
import type { AnnouncementRow, MemberRow, Store, TenantRow } from "../store/types";
import { text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { maskEmail, maskName } from "./class-common";

export async function announcementsActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("announcements");
}
async function requireAnn(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await announcementsActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「announcements」，請先 enable_module announcements");
}
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請維持 draft。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

const iso = z.iso.datetime({ offset: true });
export const announcementInput = z
  .object({
    title: text(160),
    bodyMd: z.string().max(20_000).default(""),
    pinned: z.boolean().default(false),
    startsAt: iso.nullable().optional(),
    endsAt: iso.nullable().optional(),
    audience: z.enum(["all", "members"]).default("all"),
    /** 必讀確認（會員登入後要按確認） */
    requireAck: z.boolean().default(false),
    status: z.enum(["draft", "published"]).default("draft"),
  })
  .strict()
  .refine((d) => !d.startsAt || !d.endsAt || new Date(d.endsAt) > new Date(d.startsAt), { message: "下架時間必須晚於上架時間" });

const summary = (a: AnnouncementRow) => ({ id: a.id, title: a.title, pinned: a.pinned, startsAt: a.starts_at, endsAt: a.ends_at, audience: a.audience, requireAck: a.require_ack, status: a.status, live: isLive(a) });

/** 上線中：已發布、已到上架時間、未過下架時間 */
export function isLive(a: Pick<AnnouncementRow, "status" | "starts_at" | "ends_at">, now = Date.now()) {
  return a.status === "published" && (!a.starts_at || Date.parse(a.starts_at) <= now) && (!a.ends_at || Date.parse(a.ends_at) > now);
}

export async function createAnnouncement(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof announcementInput>) {
  requireScope(ctx, "content:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireAnn(ctx, tenant);
  const d = parse(announcementInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接發布公告", confirm);
  const row = await ctx.store.insertAnnouncement({ tenant_id: tenant.id, title: d.title, body_md: d.bodyMd, pinned: d.pinned, starts_at: d.startsAt ?? null, ends_at: d.endsAt ?? null, audience: d.audience, require_ack: d.requireAck, status: d.status });
  await audit(ctx, tenant.id, "announcement.create", { id: row.id, status: row.status, requireAck: row.require_ack });
  return summary(row);
}

export async function updateAnnouncement(ctx: ServiceContext, input: { site?: string | null; announcementId: string; confirm?: boolean; patch: Partial<z.input<typeof announcementInput>> }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireAnn(ctx, tenant);
  const a = await ctx.store.getAnnouncement(tenant.id, input.announcementId);
  if (!a) throw new ServiceError("not_found", "找不到公告");
  const given = input.patch ?? {};
  const merged = parse(announcementInput, {
    title: given.title ?? a.title,
    bodyMd: given.bodyMd ?? a.body_md,
    pinned: given.pinned ?? a.pinned,
    startsAt: given.startsAt !== undefined ? given.startsAt : a.starts_at,
    endsAt: given.endsAt !== undefined ? given.endsAt : a.ends_at,
    audience: given.audience ?? a.audience,
    requireAck: given.requireAck ?? a.require_ack,
    status: given.status ?? a.status,
  });
  if (a.status === "published" || merged.status === "published") requireLiveConfirm(ctx, "修改／發布／下架已發布的公告", input.confirm);
  const row = (await ctx.store.updateAnnouncement(tenant.id, a.id, { title: merged.title, body_md: merged.bodyMd, pinned: merged.pinned, starts_at: merged.startsAt ?? null, ends_at: merged.endsAt ?? null, audience: merged.audience, require_ack: merged.requireAck, status: merged.status }))!;
  await audit(ctx, tenant.id, "announcement.update", { id: a.id, keys: Object.keys(given) });
  return summary(row);
}

export async function listAnnouncements(ctx: ServiceContext, input: { site?: string | null }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireAnn(ctx, tenant);
  const rows = await ctx.store.listAnnouncements(tenant.id, {});
  const acks = await ctx.store.listAnnouncementAcks(tenant.id, {});
  return { announcements: rows.map((a) => ({ ...summary(a), acks: acks.filter((k) => k.announcement_id === a.id).length })) };
}

/** 確認名單（個資：members:read）。reveal=false 時 email 遮罩 */
export async function listAnnouncementAcks(ctx: ServiceContext, input: { site?: string | null; announcementId: string; reveal?: boolean }) {
  requireScope(ctx, "members:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireAnn(ctx, tenant);
  const a = await ctx.store.getAnnouncement(tenant.id, input.announcementId);
  if (!a) throw new ServiceError("not_found", "找不到公告");
  const acks = await ctx.store.listAnnouncementAcks(tenant.id, { announcementId: a.id });
  const out = [];
  for (const k of acks) {
    const m = await ctx.store.getMemberById(tenant.id, k.member_id);
    out.push({ memberId: k.member_id, name: m?.name ? (input.reveal ? m.name : maskName(m.name)) : null, email: m ? (input.reveal ? m.email : maskEmail(m.email)) : null, ackedAt: k.acked_at });
  }
  if (input.reveal) await audit(ctx, tenant.id, "pii.reveal", { announcementId: a.id, acks: out.length });
  return { announcement: summary(a), total: out.length, acks: out };
}

/* ================================================================== 前台 */

/** 這位訪客看得到的上線公告（僅會員的公告要登入） */
export async function visibleAnnouncements(store: Store, tenant: TenantRow, member: MemberRow | null) {
  return (await store.listAnnouncements(tenant.id, { status: "published" })).filter((a) => isLive(a) && (a.audience === "all" || !!member));
}

/** 會員尚未確認的必讀公告 */
export async function pendingMustRead(store: Store, tenant: TenantRow, member: MemberRow | null) {
  if (!member) return [];
  const live = (await visibleAnnouncements(store, tenant, member)).filter((a) => a.require_ack);
  if (!live.length) return [];
  const mine = new Set((await store.listAnnouncementAcks(tenant.id, { memberId: member.id })).map((k) => k.announcement_id));
  return live.filter((a) => !mine.has(a.id));
}

/** 會員按「確認」：只記第一次（unique；只增不改） */
export async function acknowledgeAnnouncement(store: Store, input: { tenant: TenantRow; member: MemberRow | null; announcementId: string }) {
  if (!input.member || input.member.status !== "active") throw new ServiceError("unauthorized", "請先登入會員");
  const a = await store.getAnnouncement(input.tenant.id, input.announcementId);
  if (!a || !isLive(a) || !a.require_ack) throw new ServiceError("not_found", "找不到這則必讀公告");
  const first = await store.insertAnnouncementAck({ tenant_id: input.tenant.id, announcement_id: a.id, member_id: input.member.id });
  if (first) await store.insertAudit({ tenant_id: input.tenant.id, actor: `member:${input.member.id}`, action: "announcement.ack", payload: { announcementId: a.id } });
  return { first };
}
