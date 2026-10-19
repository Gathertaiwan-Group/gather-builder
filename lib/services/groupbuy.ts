import { createHash, randomBytes } from "node:crypto";
import { siteBase } from "../site-url";
import { z } from "zod";
import type { GroupBuySettings } from "@/modules/group-buy/manifest";
import { imageUrl, optText, postSlug, text } from "../validators";
import type {
  BankLineRow,
  CommissionKind,
  GroupBuyItemRow,
  GroupBuyLeaderRow,
  GroupBuyRow,
  GroupBuyStatus,
  MemberRow,
  OrderRow,
  PickupPoint,
  ShippingChoice,
  Store,
  TenantRow,
} from "../store/types";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings } from "./members";
import { mailSafe, placeOrder, publishedShopSettings, twd, type CheckoutDeps } from "./shop";
import { cancelOrderWithHooks, onOrderPaid } from "./orders";
import { createShipment } from "./shipping";
import { maskName, signFor, taipeiDate, toCsv, verifySigned, fmtTaipei } from "./class-orders";
import { normalizeEmail } from "../email-normalize";
import { ORDER_STATUS_LABEL } from "../shop/machine";
import { commissionFor } from "./groupbuy-hooks";
import { merchandiseNet } from "../loyalty/rules";
import { parseCsv } from "./certificates";
import type { Mailer } from "../mail";

/* ================================================================== 共用 */

export const GB_DEFAULT_RATE_PER_HOUR = 20;
export const GB_DEFAULT_MATCH_WINDOW_DAYS = 7;
const MAX_ORDERS_SCAN = 5000;

export async function groupBuyActive(store: Store, tenantId: string) {
  return activeModuleIds(await moduleStates({ store }, tenantId)).has("group-buy");
}
async function requireGroupBuy(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!(await groupBuyActive(ctx.store, tenant.id))) throw new ServiceError("forbidden", "此網站未啟用模組「group-buy」，請先 enable_module group-buy");
}
export async function publishedGroupBuySettings(store: Store, tenant: TenantRow): Promise<GroupBuySettings> {
  return (await publishedModuleSettings(store, tenant, "group-buy")) as GroupBuySettings;
}

function requireConfirm(confirm: boolean | undefined, what: string) {
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

/** 上架、改已上架的團購 → 與 publish_site 同一道門檻 */
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上團購，需要 scope「publish」。沒有 publish 權限時請維持 status: "draft"。`);
  requireConfirm(confirm, `${what}會立即對外生效`);
}

const isOpen = (g: GroupBuyRow, now = Date.now()) => g.status === "published" && (!g.starts_at || Date.parse(g.starts_at) <= now) && Date.parse(g.ends_at) > now;

export function groupBuyUrl(baseUrl: string, tenant: Pick<TenantRow, "slug">, gb: Pick<GroupBuyRow, "slug">, leaderCode?: string | null) {
  return `${siteBase(tenant, baseUrl)}/groupbuy/${gb.slug}${leaderCode ? `?leader=${encodeURIComponent(leaderCode)}` : ""}`;
}

/** 團主報表簽章連結：HMAC(PREVIEW_SECRET, gbleader:<id>:<版本>)，不存原文；版本 +1 讓舊連結失效 */
export function leaderReportToken(leader: Pick<GroupBuyLeaderRow, "id" | "report_version">) {
  return signFor("gbleader", `${leader.id}:${leader.report_version}`);
}
export function leaderReportUrl(baseUrl: string, tenant: Pick<TenantRow, "slug">, leader: Pick<GroupBuyLeaderRow, "id" | "report_version">) {
  return `${siteBase(tenant, baseUrl)}/groupbuy/leader?l=${leader.id}&t=${leaderReportToken(leader)}`;
}

const pickupInput = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{2,32}$/, { message: "自取點 id 需為 2–32 碼小寫英數或 - _" }),
    name: text(60),
    address: text(200),
    hours: optText(100),
  })
  .strict();

const itemInput = z
  .object({
    productId: z.string().trim().min(1).max(64),
    variantId: z.string().trim().max(64).nullable().optional(),
    /** 團購價（新台幣整數，可與一般售價不同） */
    price: z.number().int().min(0).max(10_000_000),
    /** 限量（null＝不限） */
    quota: z.number().int().min(1).max(1_000_000).nullable().optional(),
  })
  .strict();

export const groupBuyInput = z
  .object({
    /** "leader" 保留給團主報表頁 */
    slug: postSlug.refine((s) => s !== "leader", { message: "slug 不能是 leader（保留給團主報表）" }),
    title: text(160),
    descriptionMd: z.string().max(20_000).default(""),
    coverUrl: imageUrl.nullable().optional(),
    startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    endsAt: z.iso.datetime({ offset: true }),
    /** 成團門檻（總件數；null＝不設門檻） */
    minQty: z.number().int().min(1).max(1_000_000).nullable().optional(),
    pickupPoints: z.array(pickupInput).max(20).default([]),
    /** 允許的 shipping 模組運送方式 id（不帶＝全部） */
    shippingMethodIds: z.array(z.string().regex(/^[a-z0-9_-]{2,32}$/)).max(12).nullable().optional(),
    items: z.array(itemInput).min(1, { message: "至少一個團購品項" }).max(50),
    status: z.enum(["draft", "published"]).default("draft"),
  })
  .strict();

type GbInput = z.output<typeof groupBuyInput>;

async function validateItems(store: Store, tenant: TenantRow, items: GbInput["items"], requirePublished: boolean) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const [products, variants] = await Promise.all([store.getProductsByIds(tenant.id, ids), store.listVariants(tenant.id, ids)]);
  const seen = new Set<string>();
  return items.map((it, i) => {
    const p = products.find((x) => x.id === it.productId);
    if (!p) throw new ServiceError("invalid", `items.${i}：找不到商品 ${it.productId}`);
    if (requirePublished && p.status !== "published") throw new ServiceError("invalid", `items.${i}：「${p.name}」尚未上架，團購上架前商品要先上架`);
    const own = variants.filter((v) => v.product_id === p.id);
    const vid = it.variantId || null;
    if (own.length && !vid) throw new ServiceError("invalid", `items.${i}：「${p.name}」有規格，請帶 variantId（每個規格一個團購品項）`);
    if (vid && !own.some((v) => v.id === vid)) throw new ServiceError("invalid", `items.${i}：「${p.name}」沒有這個規格`);
    const key = `${p.id}|${vid ?? ""}`;
    if (seen.has(key)) throw new ServiceError("invalid", `items.${i}：「${p.name}」重複`);
    seen.add(key);
    return { product_id: p.id, variant_id: vid, price: it.price, quota: it.quota ?? null, sort: i };
  });
}

function checkTimes(d: Pick<GbInput, "startsAt" | "endsAt">, publishing: boolean) {
  if (d.startsAt && Date.parse(d.startsAt) >= Date.parse(d.endsAt)) throw new ServiceError("invalid", "截止時間必須晚於開團時間");
  if (publishing && Date.parse(d.endsAt) <= Date.now()) throw new ServiceError("invalid", "截止時間已過，不能上架");
}

async function findGroupBuy(ctx: ServiceContext, tenant: TenantRow, ref: { groupBuyId?: string; slug?: string }) {
  const g = ref.groupBuyId ? await ctx.store.getGroupBuy(tenant.id, ref.groupBuyId) : ref.slug ? await ctx.store.getGroupBuyBySlug(tenant.id, ref.slug) : null;
  if (!g) throw new ServiceError("not_found", "找不到團購（請給 groupBuyId 或 slug）");
  return g;
}

async function gbSummary(store: Store, tenant: TenantRow, g: GroupBuyRow, baseUrl: string) {
  const items = await store.listGroupBuyItems(tenant.id, g.id);
  const products = await store.getProductsByIds(tenant.id, [...new Set(items.map((i) => i.product_id))]);
  const variants = await store.listVariants(tenant.id, products.map((p) => p.id));
  const sold = items.reduce((s, i) => s + i.sold, 0);
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    status: g.status,
    startsAt: g.starts_at,
    endsAt: g.ends_at,
    minQty: g.min_qty,
    soldQty: sold,
    formed: g.min_qty === null || sold >= g.min_qty,
    pickupPoints: g.pickup_points,
    shippingMethodIds: g.shipping_method_ids,
    closedAt: g.closed_at,
    settledAt: g.settled_at,
    url: groupBuyUrl(baseUrl, tenant, g),
    items: items.map((i) => {
      const p = products.find((x) => x.id === i.product_id);
      const v = variants.find((x) => x.id === i.variant_id);
      return { id: i.id, productId: i.product_id, variantId: i.variant_id, name: p?.name ?? "（商品已刪除）", variantLabel: v ? Object.values(v.options).join(" / ") : null, price: i.price, regularPrice: v?.price ?? p?.price ?? null, quota: i.quota, sold: i.sold, remaining: i.quota === null ? null : Math.max(0, i.quota - i.sold) };
    }),
  };
}

/* ================================================================== 建立／修改／複製 */

export async function createGroupBuy(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof groupBuyInput>) {
  requireScope(ctx, "commerce:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireGroupBuy(ctx, tenant);
  const d = parse(groupBuyInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架團購", confirm);
  checkTimes(d, d.status === "published");
  const items = await validateItems(ctx.store, tenant, d.items, d.status === "published");
  if (await ctx.store.getGroupBuyBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `團購 slug「${d.slug}」已存在，請換一個或用 update_group_buy`);
  const g = await ctx.store.insertGroupBuy({
    tenant_id: tenant.id,
    slug: d.slug,
    title: d.title,
    description_md: d.descriptionMd,
    cover_url: d.coverUrl ?? null,
    status: d.status,
    starts_at: d.startsAt ?? null,
    ends_at: new Date(d.endsAt).toISOString(),
    min_qty: d.minQty ?? null,
    pickup_points: d.pickupPoints as PickupPoint[],
    shipping_method_ids: d.shippingMethodIds ?? null,
    copied_from: null,
  });
  await ctx.store.replaceGroupBuyItems(tenant.id, g.id, items);
  await audit(ctx, tenant.id, "group_buy.create", { groupBuyId: g.id, slug: g.slug, status: g.status, items: items.length });
  return { ...(await gbSummary(ctx.store, tenant, g, ctx.baseUrl)), note: g.status === "published" ? "團購已上架（立即對外）。" : "團購為草稿；status 改 published（需 publish＋confirm）才會開團。" };
}

export async function updateGroupBuy(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string; confirm?: boolean; patch: Partial<z.input<typeof groupBuyInput>> }) {
  requireScope(ctx, "commerce:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const g = await findGroupBuy(ctx, tenant, input);
  if (g.status !== "draft" && g.status !== "published") throw new ServiceError("conflict", `團購「${g.title}」已${g.status === "closed" ? "結團" : g.status === "failed" ? "未成團取消" : "取消"}，不能再修改（可用 duplicate_group_buy 複製一團）`);
  const given = input.patch ?? {};
  const p = parse(groupBuyInput.partial().strict(), given);
  const next = { startsAt: given.startsAt !== undefined ? (p.startsAt ?? null) : g.starts_at, endsAt: p.endsAt ?? g.ends_at, status: p.status ?? g.status };
  const publishing = next.status === "published";
  if (g.status === "published" || publishing) requireLiveConfirm(ctx, g.status === "published" ? (next.status === "draft" ? "下架團購" : "修改開團中的團購") : "上架團購", input.confirm);
  checkTimes({ startsAt: next.startsAt, endsAt: next.endsAt }, publishing);
  if (p.slug && p.slug !== g.slug && (await ctx.store.getGroupBuyBySlug(tenant.id, p.slug))) throw new ServiceError("conflict", `團購 slug「${p.slug}」已存在`);
  if (g.status === "published" && next.status === "draft" && (await ctx.store.listOrders(tenant.id, { groupBuyId: g.id, limit: 1, offset: 0 })).total > 0) {
    throw new ServiceError("conflict", "已有訂單的團購不能改回草稿；要提早截止請用 close_group_buy");
  }
  const patch: Partial<GroupBuyRow> = {};
  if (given.slug !== undefined) patch.slug = p.slug;
  if (given.title !== undefined) patch.title = p.title;
  if (given.descriptionMd !== undefined) patch.description_md = p.descriptionMd;
  if (given.coverUrl !== undefined) patch.cover_url = p.coverUrl ?? null;
  if (given.startsAt !== undefined) patch.starts_at = p.startsAt ?? null;
  if (given.endsAt !== undefined) patch.ends_at = new Date(p.endsAt!).toISOString();
  if (given.minQty !== undefined) patch.min_qty = p.minQty ?? null;
  if (given.pickupPoints !== undefined) patch.pickup_points = p.pickupPoints as PickupPoint[];
  if (given.shippingMethodIds !== undefined) patch.shipping_method_ids = p.shippingMethodIds ?? null;
  if (given.status !== undefined) patch.status = p.status;
  if (p.items !== undefined) await ctx.store.replaceGroupBuyItems(tenant.id, g.id, await validateItems(ctx.store, tenant, p.items, publishing));
  else if (publishing && g.status !== "published") {
    // 上架前確認現有品項的商品都已上架
    const cur = await ctx.store.listGroupBuyItems(tenant.id, g.id);
    if (!cur.length) throw new ServiceError("invalid", "團購沒有品項，不能上架");
    await validateItems(ctx.store, tenant, cur.map((i) => ({ productId: i.product_id, variantId: i.variant_id, price: i.price, quota: i.quota })), true);
  }
  const row = Object.keys(patch).length ? ((await ctx.store.updateGroupBuy(tenant.id, g.id, patch)) ?? g) : g;
  await audit(ctx, tenant.id, "group_buy.update", { groupBuyId: g.id, keys: Object.keys(given) });
  return gbSummary(ctx.store, tenant, row, ctx.baseUrl);
}

/** 一鍵複製既有團購為新草稿（品項與團購價、限量、自取點、團主分潤設定都帶過去；已售歸零；截止時間預設 7 天後） */
export async function duplicateGroupBuy(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string; newSlug?: string; title?: string }) {
  requireScope(ctx, "commerce:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const g = await findGroupBuy(ctx, tenant, input);
  let slug = input.newSlug ? parse(postSlug, input.newSlug) : "";
  if (slug && (await ctx.store.getGroupBuyBySlug(tenant.id, slug))) throw new ServiceError("conflict", `團購 slug「${slug}」已存在`);
  if (!slug) {
    for (let n = 2; n < 100; n++) {
      const cand = `${g.slug.slice(0, 74)}-${n}`;
      if (!(await ctx.store.getGroupBuyBySlug(tenant.id, cand))) {
        slug = cand;
        break;
      }
    }
  }
  if (!slug) throw new ServiceError("conflict", "找不到可用的 slug，請用 newSlug 指定");
  const copy = await ctx.store.insertGroupBuy({
    tenant_id: tenant.id,
    slug,
    title: (input.title?.trim() || `${g.title}（複製）`).slice(0, 160),
    description_md: g.description_md,
    cover_url: g.cover_url,
    status: "draft",
    starts_at: null,
    ends_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
    min_qty: g.min_qty,
    pickup_points: g.pickup_points,
    shipping_method_ids: g.shipping_method_ids,
    copied_from: g.id,
  });
  const items = await ctx.store.listGroupBuyItems(tenant.id, g.id);
  await ctx.store.replaceGroupBuyItems(tenant.id, copy.id, items.map((i, k) => ({ product_id: i.product_id, variant_id: i.variant_id, price: i.price, quota: i.quota, sort: k })));
  for (const a of await ctx.store.listLeaderAssignments(tenant.id, { groupBuyId: g.id })) {
    await ctx.store.upsertLeaderAssignment({ tenant_id: tenant.id, group_buy_id: copy.id, leader_id: a.leader_id, commission_kind: a.commission_kind, commission_value: a.commission_value, active: a.active });
  }
  await audit(ctx, tenant.id, "group_buy.duplicate", { from: g.id, to: copy.id });
  return { ...(await gbSummary(ctx.store, tenant, copy, ctx.baseUrl)), note: `已複製為草稿「${copy.title}」（截止時間預設 7 天後，請用 update_group_buy 調整後再上架）。` };
}

export async function listGroupBuys(ctx: ServiceContext, input: { site?: string | null; status?: GroupBuyStatus }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const rows = await ctx.store.listGroupBuys(tenant.id, { status: input.status ? [input.status] : undefined, limit: 200 });
  for (const g of rows) if (g.status === "published" && Date.parse(g.ends_at) <= Date.now()) await settleGroupBuy(ctxDeps(ctx), tenant, g).catch((e) => console.error("[group-buy] lazy settle", e));
  const fresh = await ctx.store.listGroupBuys(tenant.id, { status: input.status ? [input.status] : undefined, limit: 200 });
  return { groupBuys: await Promise.all(fresh.map((g) => gbSummary(ctx.store, tenant, g, ctx.baseUrl))) };
}

export async function getGroupBuy(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  let g = await findGroupBuy(ctx, tenant, input);
  g = await settleGroupBuy(ctxDeps(ctx), tenant, g);
  const [summary, assigns, leaders, orders] = await Promise.all([
    gbSummary(ctx.store, tenant, g, ctx.baseUrl),
    ctx.store.listLeaderAssignments(tenant.id, { groupBuyId: g.id }),
    ctx.store.listLeaders(tenant.id),
    ctx.store.listOrders(tenant.id, { groupBuyId: g.id, limit: 1000, offset: 0 }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const o of orders.rows) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  return {
    ...summary,
    orders: { total: orders.total, byStatus, paidAmount: orders.rows.filter((o) => o.status === "paid" || o.status === "fulfilled").reduce((s, o) => s + o.total, 0) },
    leaders: assigns.map((a) => {
      const l = leaders.find((x) => x.id === a.leader_id);
      return { leaderId: a.leader_id, name: l?.name ?? null, code: l?.code ?? null, commission: a.commission_kind === "percent" ? `${a.commission_value / 100}%` : `每單 ${twd(a.commission_value)}`, active: a.active && l?.status === "active", shareUrl: l ? groupBuyUrl(ctx.baseUrl, tenant, g, l.code) : null };
    }),
  };
}

/* ================================================================== 團主 */

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function leaderCode() {
  let s = "";
  for (const b of randomBytes(8)) s += ALPHA[b % ALPHA.length];
  return s;
}

/**
 * 邀請（＝店主核准）團主：同一 email 同站只有一位團主（重複邀請沿用、可改名）；帶 groupBuyId 時設定這一團的分潤。
 * 分潤：commissionPercent（0–50，可到小數兩位）或 commissionFixed（每張訂單 NT$，不超過商品淨額）。
 * rotateReportLink: true → 舊的報表連結立即失效。notify: true → 寄信給團主（專屬連結＋報表連結）。
 */
export async function inviteLeader(
  ctx: ServiceContext,
  input: { site?: string | null; groupBuyId?: string; name: string; email: string; commissionPercent?: number; commissionFixed?: number; rotateReportLink?: boolean; notify?: boolean; disable?: boolean },
) {
  requireScope(ctx, "marketing:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const name = parse(text(80), input.name);
  const email = parse(z.email({ message: "Email 格式不正確" }).max(200), (input.email ?? "").trim().toLowerCase());
  if (input.commissionPercent !== undefined && input.commissionFixed !== undefined) throw new ServiceError("invalid", "分潤請擇一：commissionPercent 或 commissionFixed");
  let kind: CommissionKind = "percent";
  let value = 0;
  if (input.commissionPercent !== undefined) {
    if (!Number.isFinite(input.commissionPercent) || input.commissionPercent < 0 || input.commissionPercent > 50) throw new ServiceError("invalid", "分潤比例需為 0–50（%）");
    value = Math.round(input.commissionPercent * 100);
  } else if (input.commissionFixed !== undefined) {
    if (!Number.isInteger(input.commissionFixed) || input.commissionFixed < 0 || input.commissionFixed > 100_000) throw new ServiceError("invalid", "固定分潤需為 0–100,000 的整數（NT$／每張訂單）");
    kind = "fixed";
    value = input.commissionFixed;
  }
  const norm = normalizeEmail(email);
  let leader = await ctx.store.getLeaderByEmail(tenant.id, norm);
  if (!leader) {
    for (let i = 0; i < 5 && !leader; i++) leader = await ctx.store.insertLeader({ tenant_id: tenant.id, name, email, email_norm: norm, code: leaderCode() });
    leader ??= await ctx.store.getLeaderByEmail(tenant.id, norm);
    if (!leader) throw new Error("無法建立團主");
  } else if (leader.name !== name) leader = (await ctx.store.updateLeader(tenant.id, leader.id, { name })) ?? leader;
  if (input.rotateReportLink) leader = (await ctx.store.updateLeader(tenant.id, leader.id, { report_version: leader.report_version + 1 })) ?? leader;
  if (input.disable !== undefined) leader = (await ctx.store.updateLeader(tenant.id, leader.id, { status: input.disable ? "disabled" : "active" })) ?? leader;
  let gb: GroupBuyRow | null = null;
  if (input.groupBuyId) {
    gb = await findGroupBuy(ctx, tenant, { groupBuyId: input.groupBuyId });
    await ctx.store.upsertLeaderAssignment({ tenant_id: tenant.id, group_buy_id: gb.id, leader_id: leader.id, commission_kind: kind, commission_value: value, active: true });
  }
  const shareUrl = gb ? groupBuyUrl(ctx.baseUrl, tenant, gb, leader.code) : null;
  const reportUrl = leaderReportUrl(ctx.baseUrl, tenant, leader);
  await audit(ctx, tenant.id, "group_buy.leader", { leaderId: leader.id, groupBuyId: gb?.id ?? null, kind, value, rotated: !!input.rotateReportLink });
  if (input.notify) {
    await mailSafe(ctx, leader.email, `【${tenant.name}】團主邀請${gb ? `：${gb.title}` : ""}`, `${leader.name} 你好，\n\n${tenant.name} 邀請你擔任團主。${gb ? `\n你的專屬團購連結：${shareUrl}\n分潤：${kind === "percent" ? `商品實付金額的 ${value / 100}%` : `每張訂單 ${twd(value)}`}（訂單付款後計入、取消會沖回）` : ""}\n\n你的團主報表（訂單數、金額、分潤、出貨狀態；不含買家個資）：\n${reportUrl}\n請勿把報表連結轉給他人。`);
  }
  return { leaderId: leader.id, name: leader.name, code: leader.code, status: leader.status, commission: gb ? { kind, value: kind === "percent" ? value / 100 : value } : null, shareUrl, reportUrl, note: "報表連結含簽章、不要公開分享；要讓舊連結失效請帶 rotateReportLink: true。" };
}

/* ================================================================== 前台：團購頁與下單 */

export interface PublicGroupBuyItem {
  id: string;
  productId: string;
  productSlug: string;
  name: string;
  variantLabel: string | null;
  image: string | null;
  price: number;
  regularPrice: number;
  remaining: number | null;
}

/** 前台讀取：只回上架（或已結團可看結果）的團購；截止的會先 lazy 結團 */
export async function publicGroupBuy(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, slug: string, opts: { preview?: boolean } = {}) {
  let g = await deps.store.getGroupBuyBySlug(tenant.id, slug);
  if (!g || (g.status === "draft" && !opts.preview)) return null;
  if (g.status === "published" && Date.parse(g.ends_at) <= Date.now()) g = await settleGroupBuy(deps, tenant, g).catch(() => g!);
  const items = await deps.store.listGroupBuyItems(tenant.id, g.id);
  const products = await deps.store.getProductsByIds(tenant.id, [...new Set(items.map((i) => i.product_id))]);
  const variants = await deps.store.listVariants(tenant.id, products.map((p) => p.id));
  const list: PublicGroupBuyItem[] = [];
  for (const i of items) {
    const p = products.find((x) => x.id === i.product_id);
    if (!p || (p.status !== "published" && !opts.preview)) continue;
    const v = variants.find((x) => x.id === i.variant_id);
    const stockLeft = p.track_inventory ? (v ? v.stock : p.stock) : null;
    const quotaLeft = i.quota === null ? null : Math.max(0, i.quota - i.sold);
    const remaining = stockLeft === null ? quotaLeft : quotaLeft === null ? stockLeft : Math.min(stockLeft, quotaLeft);
    list.push({ id: i.id, productId: p.id, productSlug: p.slug, name: p.name, variantLabel: v ? Object.values(v.options).join(" / ") : null, image: p.images[0] ?? null, price: i.price, regularPrice: v?.price ?? p.price, remaining });
  }
  const sold = items.reduce((s, i) => s + i.sold, 0);
  return { groupBuy: g, items: list, open: isOpen(g), soldQty: sold, formed: g.min_qty === null || sold >= g.min_qty };
}

export async function publicGroupBuys(store: Store, tenant: TenantRow, opts: { limit: number; showClosed: boolean }) {
  const rows = await store.listGroupBuys(tenant.id, { status: opts.showClosed ? ["published", "closed"] : ["published"], limit: 100 });
  const live = rows.filter((g) => (opts.showClosed ? true : isOpen(g)));
  const out = [];
  for (const g of live.slice(0, opts.limit)) {
    const items = await store.listGroupBuyItems(tenant.id, g.id);
    out.push({ groupBuy: g, minPrice: items.length ? Math.min(...items.map((i) => i.price)) : null, open: isOpen(g) });
  }
  return out;
}

/** 團主參數 → 有效團主（啟用中、被指派到這一團且指派有效）；無效一律回 null（不洩漏原因） */
export async function leaderForGroupBuy(store: Store, tenant: TenantRow, g: GroupBuyRow, code: string | null | undefined) {
  if (!code || !/^[A-Z2-9]{8}$/.test(code)) return null;
  const leader = await store.getLeaderByCode(tenant.id, code);
  if (!leader || leader.status !== "active") return null;
  const a = (await store.listLeaderAssignments(tenant.id, { groupBuyId: g.id, leaderId: leader.id }))[0];
  if (!a || !a.active) return null;
  return { leader, assignment: a };
}

export const groupBuyOrderInput = z
  .object({
    items: z
      .array(z.object({ itemId: z.string().trim().min(1).max(64), qty: z.number().int().min(1).max(99) }).strict())
      .min(1, { message: "請至少選一項" })
      .max(30),
    contact: z.unknown(),
    shipping: z.unknown().optional(),
    note: optText(500),
    paymentMethod: z.string().max(20),
    pchomepayType: z.enum(["card", "atm"]).optional(),
    invoice: z.unknown().optional(),
    shippingMethodId: z.string().trim().max(32).optional(),
    cvsSelectionId: z.string().trim().max(64).optional(),
    /** 到店自取點 id（團購設定的自取點） */
    pickupPointId: z.string().trim().max(32).optional(),
    couponCode: z.string().trim().max(32).optional(),
    /** 團主連結的 ?leader=<碼> */
    leaderCode: z.string().trim().max(16).optional(),
    /** 銀行轉帳：匯款帳號末五碼（也可以下單後在訂單頁回報） */
    payerLast5: z
      .string()
      .trim()
      .regex(/^\d{5}$/, { message: "帳號末五碼需為 5 位數字" })
      .optional(),
  })
  .strict();

/**
 * 團購下單（免登入或會員）：組好「團購價＋團購資料」後交給既有 placeOrder（同一套計價、庫存、優惠券、折抵、發票、運費、付款方式、寄信）。
 * 限量在 builder_place_group_buy_order 同一交易原子扣減；團購價只來自 DB 的團購品項。
 */
export async function placeGroupBuyOrder(deps: CheckoutDeps, input: { tenant: TenantRow; member: MemberRow | null; slug: string; data: unknown; allowSandbox?: boolean; cvsBinding?: string | null }) {
  const { tenant } = input;
  if (!(await groupBuyActive(deps.store, tenant.id))) throw new ServiceError("forbidden", "此網站未開放團購");
  let g = await deps.store.getGroupBuyBySlug(tenant.id, input.slug);
  if (!g) throw new ServiceError("not_found", "找不到這個團購");
  if (g.status === "published" && Date.parse(g.ends_at) <= Date.now()) g = await settleGroupBuy(deps, tenant, g);
  if (!isOpen(g)) throw new ServiceError("conflict", g.starts_at && Date.parse(g.starts_at) > Date.now() ? "這個團購還沒開團" : "這個團購已截止");
  const d = parse(groupBuyOrderInput, input.data);
  const items = await deps.store.listGroupBuyItems(tenant.id, g.id);
  const products = await deps.store.getProductsByIds(tenant.id, [...new Set(items.map((i) => i.product_id))]);
  const variants = await deps.store.listVariants(tenant.id, products.map((p) => p.id));
  const prices = new Map<string, { itemId: string; price: number; name: string }>();
  for (const i of items) {
    const p = products.find((x) => x.id === i.product_id);
    const v = variants.find((x) => x.id === i.variant_id);
    prices.set(`${i.product_id}|${i.variant_id ?? ""}`, { itemId: i.id, price: i.price, name: `${p?.name ?? "商品"}${v ? `（${Object.values(v.options).join(" / ")}）` : ""}` });
  }
  const cart = d.items.map((x) => {
    const it = items.find((i) => i.id === x.itemId);
    if (!it) throw new ServiceError("invalid", "選的品項不在這個團購裡");
    return { productId: it.product_id, variantId: it.variant_id, qty: x.qty };
  });
  // 團主：有效且不是自己買自己的團
  const contactEmail = typeof (d.contact as { email?: unknown })?.email === "string" ? String((d.contact as { email: string }).email).trim().toLowerCase() : "";
  const lead = await leaderForGroupBuy(deps.store, tenant, g, d.leaderCode?.toUpperCase());
  // 第八批審查 L-2：盡力防範團主自己買自己的團——email（正規化）之外，也比對電話（只留數字、09 開頭）與收件地址（去空白、全形轉半形）。
  // 限制：團主用別人的 email／電話／地址下單仍無法辨識（見 ARCHITECTURE 已知風險）。
  const self = !!lead && (normalizeEmail(contactEmail) === lead.leader.email_norm || (!!input.member && normalizeEmail(input.member.email) === lead.leader.email_norm) || (await sameAsLeader(deps.store, tenant, lead.leader, d)));
  const leader = lead && !self ? lead : null;
  // 到店自取
  let pickup: ShippingChoice | null = null;
  const shipping = (d.shipping ?? {}) as { name?: string; phone?: string; address?: string };
  if (d.pickupPointId) {
    const pt = g.pickup_points.find((p) => p.id === d.pickupPointId);
    if (!pt) throw new ServiceError("invalid", "找不到這個自取點");
    pickup = { methodId: `pickup:${pt.id}`, type: "pickup", provider: "manual", subType: null, label: `到店自取：${pt.name}`, fee: 0, store: { id: pt.id, name: pt.name, address: pt.address, outside: false }, cvsSelectionId: null };
  }
  const c = (d.contact ?? {}) as { name?: string; phone?: string };
  const data = {
    items: cart,
    contact: d.contact,
    shipping: pickup ? { name: shipping.name || c.name || "", phone: shipping.phone || c.phone || "", address: shipping.address?.trim() || `到店自取：${pickup.store!.name}` } : d.shipping,
    note: d.note,
    paymentMethod: d.paymentMethod,
    pchomepayType: d.pchomepayType,
    invoice: d.invoice,
    shippingMethodId: pickup ? undefined : d.shippingMethodId,
    cvsSelectionId: pickup ? undefined : d.cvsSelectionId,
    couponCode: d.couponCode,
  };
  const r = await placeOrder(deps, {
    tenant,
    member: input.member,
    data,
    allowSandbox: input.allowSandbox,
    cvsBinding: input.cvsBinding,
    groupBuy: {
      prices,
      order: { group_buy_id: g.id, leader_id: leader?.leader.id ?? null, payer_last5: d.payerLast5 ?? null, commission_kind: leader?.assignment.commission_kind ?? null, commission_value: leader?.assignment.commission_value ?? null },
      allowedMethodIds: g.shipping_method_ids,
      pickup,
    },
  });
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: input.member ? `member:${input.member.id}` : "guest", action: "group_buy.order", payload: { groupBuyId: g.id, orderNo: r.order.order_no, leaderId: leader?.leader.id ?? null, selfLeaderIgnored: self } });
  return { ...r, groupBuy: g };
}

/** 客人在訂單頁回報匯款帳號末五碼（只限團購單、線下匯款、仍待付款） */
export async function reportPayerLast5(store: Store, tenant: TenantRow, order: OrderRow, last5: unknown) {
  const v = parse(z.string().trim().regex(/^\d{5}$/, { message: "帳號末五碼需為 5 位數字" }), last5);
  if (!order.group_buy_id || order.payment_method !== "offline" || order.status !== "pending_payment") throw new ServiceError("invalid", "這張訂單不需要回報匯款資料");
  if (!(await store.setGroupBuyPayerLast5(tenant.id, order.id, v))) throw new ServiceError("not_found", "找不到團購訂單");
  await store.insertAudit({ tenant_id: tenant.id, actor: "guest", action: "group_buy.report_transfer", payload: { orderNo: order.order_no } });
  return { ok: true };
}

/* ================================================================== 結團（截止自動、提早結團） */

const ctxDeps = (ctx: ServiceContext) => ({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl });

async function listAllGroupBuyOrders(store: Store, tenantId: string, groupBuyId: string): Promise<OrderRow[]> {
  const out: OrderRow[] = [];
  for (let offset = 0; offset < MAX_ORDERS_SCAN; offset += 100) {
    const r = await store.listOrders(tenantId, { groupBuyId, limit: 100, offset });
    out.push(...r.rows);
    if (r.rows.length < 100) break;
  }
  return out;
}

/**
 * 結團（冪等、可中斷後接續）：
 * 1. 開團中且已截止 → 依「有效訂單的件數」（＝各品項 sold 加總：已取消的單會在同一交易釋放限量）判斷成團 → 條件式轉 closed／failed（只成功一次）。
 * 2. closed／failed 但還沒處理完（settled_at null）→ 未成團：取消所有未取消的訂單（cancelOrderWithHooks，冪等）；
 *    每張訂單的成團／未成團通知用 builder_group_buy_notices（unique）保證只寄一次；全部完成才標 settled_at 並寄店主摘要。
 * 已付款的未成團訂單會被取消並標「需退款」（不自動退款，見 refund_order）。
 */
export async function settleGroupBuy(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, tenant: TenantRow, gIn: GroupBuyRow, opts: { force?: boolean } = {}): Promise<GroupBuyRow> {
  let g = gIn;
  if (g.status === "published" && (opts.force || Date.parse(g.ends_at) <= Date.now())) {
    const items = await deps.store.listGroupBuyItems(tenant.id, g.id);
    const qty = items.reduce((s, i) => s + i.sold, 0);
    const outcome: GroupBuyStatus = g.min_qty !== null && qty < g.min_qty ? "failed" : "closed";
    const nowIso = new Date().toISOString();
    const moved = await deps.store.transitionGroupBuy(tenant.id, g.id, ["published"], outcome, { closed_at: nowIso, ...(Date.parse(g.ends_at) > Date.now() ? { ends_at: nowIso } : {}) });
    if (moved) await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:group-buy", action: `group_buy.${outcome}`, payload: { groupBuyId: g.id, qty, minQty: g.min_qty } });
    g = moved ?? (await deps.store.getGroupBuy(tenant.id, g.id)) ?? g;
  }
  if ((g.status !== "closed" && g.status !== "failed") || g.settled_at) return g;
  const orders = await listAllGroupBuyOrders(deps.store, tenant.id, g.id);
  const shop = await publishedShopSettings(deps.store, tenant);
  let cancelled = 0;
  let refundRequired = 0;
  let notified = 0;
  // 第八批審查 L-1：回報過匯款末五碼（已匯款、待對帳）的待付款單 → 也要列入「需退款／需聯絡」
  const reported = new Set(g.status === "failed" ? (await deps.store.listGroupBuyOrderRows(tenant.id, { groupBuyId: g.id })).filter((r) => !!r.payer_last5).map((r) => r.order_id) : []);
  const contactNeeded: string[] = [];
  for (const o of orders) {
    if (g.status === "failed") {
      const transferReported = o.status === "pending_payment" && reported.has(o.id);
      if (o.status === "pending_payment" || o.status === "paid") {
        const was = o.status;
        const r = await cancelOrderWithHooks(deps, tenant, o.id, [was], "group_buy_failed");
        if (r.transitioned) {
          cancelled++;
          if (was === "paid") refundRequired++;
          if (transferReported) contactNeeded.push(o.order_no);
        }
      }
      const after = (await deps.store.getOrderById(tenant.id, o.id)) ?? o;
      if (after.cancel_reason === "group_buy_failed" && (await deps.store.insertGroupBuyNotice({ tenant_id: tenant.id, group_buy_id: g.id, order_id: o.id, kind: "failed" }))) {
        notified++;
        const tail = o.status === "paid" ? "\n你已付款的金額，店家會儘快退款給你。" : transferReported ? "\n你已回報匯款（帳號末五碼），店家核對入帳後會與你聯絡並退回已匯款項。" : "\n尚未付款的訂單不需再付款。";
        await mailSafe(deps, o.contact.email, `【${tenant.name}】團購未成團：${g.title}`, `${o.contact.name} 你好，\n\n很抱歉，「${g.title}」截止時未達成團門檻（${g.min_qty} 件），你的訂單 ${o.order_no} 已取消。${tail}`);
      }
    } else if (o.status !== "cancelled" && (await deps.store.insertGroupBuyNotice({ tenant_id: tenant.id, group_buy_id: g.id, order_id: o.id, kind: "formed" }))) {
      notified++;
      await mailSafe(deps, o.contact.email, `【${tenant.name}】團購成團：${g.title}`, `${o.contact.name} 你好，\n\n「${g.title}」已成團！你的訂單 ${o.order_no}${o.status === "pending_payment" ? " 尚未付款，請儘快完成付款（逾期會自動取消）" : " 已確認，我們會依序安排出貨"}。`);
    }
  }
  if (await deps.store.markGroupBuySettled(tenant.id, g.id)) {
    await deps.store.insertAudit({ tenant_id: tenant.id, actor: "system:group-buy", action: "group_buy.settled", payload: { groupBuyId: g.id, status: g.status, orders: orders.length, cancelled, refundRequired, notified, transferReported: contactNeeded } });
    if (shop.ownerEmail) {
      await mailSafe(deps, shop.ownerEmail, `【${tenant.name}】團購${g.status === "closed" ? "已結團（成團）" : "未成團（已自動取消訂單）"}：${g.title}`, `團購「${g.title}」${g.status === "closed" ? "已成團結團" : `未達門檻 ${g.min_qty} 件，已取消 ${cancelled} 張訂單`}。\n訂單數：${orders.length}${refundRequired ? `\n🔴 其中 ${refundRequired} 張已付款，需要退款（可用 refund_order 或到金流後台／自行退款）` : ""}${contactNeeded.length ? `\n🔴 另有 ${contactNeeded.length} 張待付款訂單客人已回報匯款末五碼（${contactNeeded.join("、")}）：請核對銀行入帳，已入帳的需退款並聯絡客人` : ""}\n出貨報表請用 export_shipping。`);
    }
  }
  return (await deps.store.getGroupBuy(tenant.id, g.id)) ?? g;
}

/** 每日 cron：已截止的開團中團購結團＋接續還沒處理完的結團（冪等） */
export async function sweepGroupBuys(deps: { store: Store; sendMail?: Mailer; baseUrl: string }, limit = 50) {
  const due = await deps.store.listDueGroupBuys(new Date().toISOString(), limit);
  let settled = 0;
  for (const d of due) {
    const tenant = await deps.store.getTenantById(d.tenant_id);
    const g = tenant ? await deps.store.getGroupBuy(tenant.id, d.id) : null;
    if (!tenant || !g) continue;
    const after = await settleGroupBuy(deps, tenant, g).catch((e) => (console.error("[group-buy] settle", e), g));
    if (after.settled_at) settled++;
  }
  return { scanned: due.length, settled };
}

/** 提早結團（MCP close_group_buy；orders:write＋confirm）：截止時間改成現在並結團 */
export async function closeGroupBuy(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string; confirm?: boolean }) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const g = await findGroupBuy(ctx, tenant, input);
  if (g.status !== "published") {
    if ((g.status === "closed" || g.status === "failed") && !g.settled_at) return { ...(await gbSummary(ctx.store, tenant, await settleGroupBuy(ctxDeps(ctx), tenant, g), ctx.baseUrl)), note: "接續完成結團處理" };
    throw new ServiceError("conflict", `團購「${g.title}」目前不是開團中（${g.status}）`);
  }
  const items = await ctx.store.listGroupBuyItems(tenant.id, g.id);
  const qty = items.reduce((s, i) => s + i.sold, 0);
  const fail = g.min_qty !== null && qty < g.min_qty;
  const orders = await ctx.store.listOrders(tenant.id, { groupBuyId: g.id, limit: 1, offset: 0 });
  requireConfirm(input.confirm, `結團「${g.title}」：目前 ${qty} 件／${orders.total} 張訂單${g.min_qty !== null ? `，門檻 ${g.min_qty} 件` : ""} → ${fail ? "🔴 未達門檻，會取消所有訂單並通知（已付款的需退款）" : "成團，會通知所有訂購人"}；結團後不能再下單`);
  const after = await settleGroupBuy(ctxDeps(ctx), tenant, g, { force: true });
  await audit(ctx, tenant.id, "group_buy.close", { groupBuyId: g.id, outcome: after.status });
  return { ...(await gbSummary(ctx.store, tenant, after, ctx.baseUrl)), note: after.status === "failed" ? "未達門檻：已取消訂單並通知訂購人。" : "已成團結團並通知訂購人；出貨報表請用 export_shipping。" };
}

/* ================================================================== 訂單列表、出貨匯出、批次物流單 */

export async function listGroupBuyOrders(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string; status?: OrderRow["status"]; leaderId?: string; limit?: number; offset?: number }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const g = await findGroupBuy(ctx, tenant, input);
  const lim = Math.max(1, Math.min(200, input.limit ?? 50));
  const r = await ctx.store.listOrders(tenant.id, { groupBuyId: g.id, status: input.status, leaderId: input.leaderId, limit: lim, offset: Math.max(0, input.offset ?? 0) });
  const [ext, leaders, comm] = await Promise.all([
    ctx.store.listGroupBuyOrderRows(tenant.id, { orderIds: r.rows.map((o) => o.id) }),
    ctx.store.listLeaders(tenant.id),
    ctx.store.listGroupBuyCommissions(tenant.id, { orderIds: r.rows.map((o) => o.id) }),
  ]);
  return {
    groupBuy: { id: g.id, slug: g.slug, title: g.title, status: g.status },
    total: r.total,
    orders: r.rows.map((o) => {
      const x = ext.find((e) => e.order_id === o.id);
      const l = leaders.find((y) => y.id === o.group_buy_leader_id);
      return {
        orderNo: o.order_no,
        status: o.status,
        statusLabel: ORDER_STATUS_LABEL[o.status],
        paymentMethod: o.payment_method,
        total: o.total,
        contactName: o.contact.name,
        payerLast5: x?.payer_last5 ?? null,
        items: o.items.map((i) => ({ name: i.name, variantLabel: i.variant_label, qty: i.qty, unitPrice: i.unit_price })),
        shipping: o.shipping_choice?.label ?? null,
        leader: l ? { id: l.id, name: l.name } : null,
        commission: comm.filter((c) => c.order_id === o.id).reduce((s, c) => s + c.amount, 0),
        createdAt: o.created_at,
        paidAt: o.paid_at,
      };
    }),
    note: "清單只含姓名；收件電話與地址請用 export_shipping（會記錄個資查看）。",
  };
}

/**
 * 出貨報表／物流匯出（CSV，含收件人電話與地址、超商門市、自取點）。🔴 每格防 CSV injection（csvCell）、匯出前先寫 builder_pii_access_log（只增不改）＋稽核。
 * 預設只匯出已付款（未出貨）的訂單；includeFulfilled 也帶已出貨。
 */
export async function exportShipping(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string; includeFulfilled?: boolean; reason?: string }) {
  requireScope(ctx, "orders:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const g = await findGroupBuy(ctx, tenant, input);
  const all = await listAllGroupBuyOrders(ctx.store, tenant.id, g.id);
  const rows = all.filter((o) => !o.payment_sandbox && (o.status === "paid" || (input.includeFulfilled && o.status === "fulfilled")));
  await ctx.store.insertPiiLog({ tenant_id: tenant.id, actor: ctx.actor.label, action: "export", subject_type: "group_buy_shipping", subject_id: g.id, detail: { rows: rows.length, reason: input.reason?.slice(0, 200) ?? null } });
  await audit(ctx, tenant.id, "pii.export", { groupBuyId: g.id, rows: rows.length, kind: "group_buy_shipping" });
  const leaders = await ctx.store.listLeaders(tenant.id);
  const csv = toCsv(
    ["訂單編號", "狀態", "下單時間", "收件人", "收件電話", "收件地址", "運送方式", "超商／自取點代號", "超商／自取點名稱", "超商／自取點地址", "品項", "件數", "訂單金額", "團主", "備註"],
    rows.map((o) => [
      o.order_no,
      ORDER_STATUS_LABEL[o.status],
      fmtTaipei(o.created_at, false),
      o.shipping.name,
      o.shipping.phone,
      o.shipping_choice?.type === "cvs" || o.shipping_choice?.type === "pickup" ? "" : o.shipping.address,
      o.shipping_choice?.label ?? "",
      o.shipping_choice?.store?.id ?? "",
      o.shipping_choice?.store?.name ?? "",
      o.shipping_choice?.store?.address ?? "",
      o.items.map((i) => `${i.name}${i.variant_label ? `（${i.variant_label}）` : ""}×${i.qty}`).join("；"),
      o.items.reduce((s, i) => s + i.qty, 0),
      o.total,
      leaders.find((l) => l.id === o.group_buy_leader_id)?.name ?? "",
      o.note ?? "",
    ]),
  );
  return { groupBuy: { id: g.id, slug: g.slug, title: g.title }, rows: rows.length, filename: `groupbuy-${g.slug}-shipping-${taipeiDate(Date.now())}.csv`, csv, note: "含個資：已記錄這次匯出（誰、何時、幾筆）。請妥善保存、用完刪除。" };
}

/** 批次建立綠界物流單（shipping:write＋confirm）：只處理已付款、選綠界物流、還沒有有效物流單的團購單；逐單沿用 create_shipment（同一訂單只能一張有效物流單＝冪等） */
export async function createGroupBuyShipments(ctx: ServiceContext, input: { site?: string | null; groupBuyId?: string; slug?: string; confirm?: boolean; limit?: number }) {
  requireScope(ctx, "shipping:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const g = await findGroupBuy(ctx, tenant, input);
  const all = await listAllGroupBuyOrders(ctx.store, tenant.id, g.id);
  const todo: OrderRow[] = [];
  for (const o of all) {
    if (o.status !== "paid" || o.shipping_choice?.provider !== "ecpay") continue;
    if (await ctx.store.getActiveShipmentByOrder(tenant.id, o.id)) continue;
    todo.push(o);
  }
  const batch = todo.slice(0, Math.max(1, Math.min(100, input.limit ?? 50)));
  requireConfirm(input.confirm, `為「${g.title}」建立 ${batch.length} 張綠界物流單（共 ${todo.length} 張待建）`);
  const results: { orderNo: string; ok: boolean; message: string }[] = [];
  for (const o of batch) {
    try {
      const r = (await createShipment(ctx, { site: tenant.slug, orderId: o.id, confirm: true })) as { status?: string; logisticsId?: string | null };
      results.push({ orderNo: o.order_no, ok: true, message: `${r.status ?? "created"}${r.logisticsId ? ` ${r.logisticsId}` : ""}` });
    } catch (e) {
      results.push({ orderNo: o.order_no, ok: false, message: e instanceof ServiceError ? e.message : "建立失敗" });
    }
  }
  await audit(ctx, tenant.id, "group_buy.shipments", { groupBuyId: g.id, attempted: batch.length, ok: results.filter((r) => r.ok).length });
  return { attempted: batch.length, remaining: todo.length - batch.length, results };
}

/* ================================================================== 團主報表（簽章連結；遮罩買家） */

export async function leaderReport(store: Store, tenant: TenantRow, leaderId: string | null | undefined, token: string | null | undefined) {
  if (!leaderId || !/^[0-9a-f-]{36}$/i.test(leaderId)) return null;
  const leader = await store.getLeader(tenant.id, leaderId);
  if (!leader || leader.status !== "active" || !verifySigned("gbleader", `${leader.id}:${leader.report_version}`, token)) return null;
  const [assigns, ordersRes, comm] = await Promise.all([
    store.listLeaderAssignments(tenant.id, { leaderId: leader.id }),
    store.listOrders(tenant.id, { leaderId: leader.id, limit: 1000, offset: 0 }),
    store.listGroupBuyCommissions(tenant.id, { leaderId: leader.id }),
  ]);
  const gbs = (await Promise.all(assigns.map((a) => store.getGroupBuy(tenant.id, a.group_buy_id)))).filter((x): x is GroupBuyRow => !!x);
  const shipments = await Promise.all(ordersRes.rows.map((o) => store.getActiveShipmentByOrder(tenant.id, o.id)));
  const orders = ordersRes.rows.map((o, i) => {
    const c = comm.filter((x) => x.order_id === o.id).reduce((s, x) => s + x.amount, 0);
    const sh = shipments[i];
    return {
      orderNo: o.order_no,
      groupBuy: gbs.find((g) => g.id === o.group_buy_id)?.title ?? "",
      createdAt: o.created_at,
      status: o.status,
      statusLabel: ORDER_STATUS_LABEL[o.status],
      /** 🔴 只給遮罩後的姓名，不給 email／電話／地址 */
      buyer: maskName(o.contact.name),
      qty: o.items.reduce((s, x) => s + x.qty, 0),
      amount: merchandiseNet(o),
      commission: c,
      shipping: o.status === "fulfilled" ? "已出貨" : sh ? (sh.status === "created" ? "物流單已建立" : sh.status) : o.status === "paid" ? "待出貨" : "-",
    };
  });
  const live = orders.filter((o) => o.status !== "cancelled");
  return {
    leader: { name: leader.name, code: leader.code },
    groupBuys: gbs.map((g) => {
      const a = assigns.find((x) => x.group_buy_id === g.id)!;
      return { title: g.title, status: g.status, endsAt: g.ends_at, commission: a.commission_kind === "percent" ? `${a.commission_value / 100}%` : `每單 ${twd(a.commission_value)}`, shareUrlPath: `/groupbuy/${g.slug}?leader=${leader.code}` };
    }),
    totals: { orders: live.length, paidOrders: live.filter((o) => o.status === "paid" || o.status === "fulfilled").length, amount: live.filter((o) => o.status === "paid" || o.status === "fulfilled").reduce((s, o) => s + o.amount, 0), commission: comm.reduce((s, x) => s + x.amount, 0) },
    orders,
  };
}

/* ================================================================== 銀行明細 CSV 對帳 */

export interface BankCsvRow {
  txnDate: string;
  amount: number;
  last5: string | null;
  memo: string | null;
}

const BANK_HEADERS: Record<string, keyof BankCsvRow> = {
  日期: "txnDate", 交易日期: "txnDate", 入帳日期: "txnDate", date: "txnDate",
  金額: "amount", 存入: "amount", 存入金額: "amount", 入帳金額: "amount", amount: "amount",
  帳號末五碼: "last5", 末五碼: "last5", 轉出帳號: "last5", 匯款帳號: "last5", 帳號: "last5", last5: "last5", account: "last5",
  備註: "memo", 摘要: "memo", 附言: "memo", memo: "memo", note: "memo",
};
/** 🔴 CSV injection：= + - @ Tab CR（含全形 ＝＋－＠）開頭的儲存格一律拒絕（不讓公式進 DB；負數＝支出，也不收） */
const FORMULA = /^[=+\-@\t\r＝＋－＠]/;
export const BANK_CSV_MAX_ROWS = 2000;
export const BANK_CSV_MAX_BYTES = 300_000;

/** 解析＋驗證銀行明細 CSV（任何一列有錯整份不匯入） */
export function parseBankCsv(text: string): BankCsvRow[] {
  if (typeof text !== "string" || !text.trim()) throw new ServiceError("invalid", "CSV 是空的");
  if (Buffer.byteLength(text, "utf8") > BANK_CSV_MAX_BYTES) throw new ServiceError("invalid", `CSV 太大（上限 ${BANK_CSV_MAX_BYTES / 1000}KB）`);
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ServiceError("invalid", "CSV 至少要有標題列與一筆資料");
  if (rows.length - 1 > BANK_CSV_MAX_ROWS) throw new ServiceError("invalid", `一次最多 ${BANK_CSV_MAX_ROWS} 筆`);
  const header = rows[0]!.map((h) => BANK_HEADERS[h.trim().toLowerCase()] ?? BANK_HEADERS[h.trim()]);
  if (!header.includes("txnDate") || !header.includes("amount")) throw new ServiceError("invalid", "標題列需要「日期」與「金額」（另可有「帳號末五碼」「備註」）");
  const errors: string[] = [];
  const out: BankCsvRow[] = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k: keyof BankCsvRow) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (r[idx] ?? "").trim() : "";
    };
    for (const cell of r) if (FORMULA.test(cell) || FORMULA.test(cell.trimStart())) {
      errors.push(`第 ${line} 列：儲存格不能以 = + - @ 或 Tab 開頭（${cell.trim().slice(0, 12)}）`);
      return;
    }
    const dm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(get("txnDate"));
    const date = dm ? `${dm[1]}-${dm[2]!.padStart(2, "0")}-${dm[3]!.padStart(2, "0")}` : "";
    if (!dm || Number.isNaN(Date.parse(`${date}T00:00:00+08:00`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
      errors.push(`第 ${line} 列：日期格式需為 YYYY-MM-DD（${get("txnDate").slice(0, 20)}）`);
      return;
    }
    const amtRaw = get("amount").replace(/,/g, "").replace(/^NT\$|^\$/i, "");
    if (!/^\d{1,9}(?:\.0{1,2})?$/.test(amtRaw) || Number(amtRaw) <= 0) {
      errors.push(`第 ${line} 列：金額需為正整數（${get("amount").slice(0, 20)}）`);
      return;
    }
    const acct = get("last5").replace(/[\s-]/g, "");
    let last5: string | null = null;
    if (acct) {
      if (!/^\d{5,20}$/.test(acct)) {
        errors.push(`第 ${line} 列：帳號末五碼需為數字（${acct.slice(0, 20)}）`);
        return;
      }
      last5 = acct.slice(-5);
    }
    const memo = get("memo").slice(0, 200) || null;
    out.push({ txnDate: date, amount: Math.round(Number(amtRaw)), last5, memo });
  });
  if (errors.length) throw new ServiceError("invalid", `CSV 有 ${errors.length} 列錯誤，整份未匯入：${errors.slice(0, 10).join("；")}${errors.length > 10 ? "…" : ""}`);
  return out;
}

export interface MatchCandidateOrder {
  id: string;
  order_no: string;
  total: number;
  created_at: string;
  payer_last5: string | null;
}

/**
 * 配對（純函式）：明細 × 待付款的線下匯款訂單。
 * 候選＝金額相同，且（帳號末五碼相同、或備註含訂單編號），且匯款日期在下單日（台北）～之後 windowDays 天內。
 * 🔴 只有「一筆明細剛好一張候選單、那張單也只被這一筆明細選到」才建議；多重候選＝ambiguous，不自動配；被店主拒絕過的組合不再建議。
 */
export function suggestBankMatches(lines: Pick<BankLineRow, "id" | "txn_date" | "amount" | "last5" | "memo">[], orders: MatchCandidateOrder[], windowDays: number, rejected: Set<string> = new Set()) {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400_000;
  const cands = new Map<string, string[]>();
  for (const l of lines) {
    const memo = (l.memo ?? "").toUpperCase();
    const hit = orders.filter((o) => {
      if (o.total !== l.amount || rejected.has(`${l.id}|${o.id}`)) return false;
      const byLast5 = !!l.last5 && !!o.payer_last5 && l.last5 === o.payer_last5;
      const byNo = !!memo && memo.includes(o.order_no.toUpperCase());
      if (!byLast5 && !byNo) return false;
      const diff = day(l.txn_date) - day(taipeiDate(new Date(o.created_at)));
      return diff >= 0 && diff <= windowDays;
    });
    cands.set(l.id, hit.map((o) => o.id));
  }
  const orderHits = new Map<string, number>();
  for (const ids of cands.values()) for (const id of ids) orderHits.set(id, (orderHits.get(id) ?? 0) + 1);
  const suggested: { lineId: string; orderId: string }[] = [];
  const ambiguous: { lineId: string; orderIds: string[] }[] = [];
  const unmatched: string[] = [];
  for (const [lineId, ids] of cands) {
    if (!ids.length) unmatched.push(lineId);
    else if (ids.length === 1 && orderHits.get(ids[0]!) === 1) suggested.push({ lineId, orderId: ids[0]! });
    else ambiguous.push({ lineId, orderIds: ids });
  }
  return { suggested, ambiguous, unmatched };
}

/**
 * 匯入銀行明細（orders:write）：驗證 → 寫入明細（同一份重複匯入不重複建立）→ 對所有尚未配對的明細跑配對 → **只產生建議**，不改任何訂單狀態。
 * 店主確認後用 confirm_bank_matches 標記已付款。
 */
export async function importBankStatement(ctx: ServiceContext, input: { site?: string | null; csv: string; filename?: string }) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const rows = parseBankCsv(input.csv);
  const settings = await publishedGroupBuySettings(ctx.store, tenant);
  const imp = await ctx.store.insertBankImport({ tenant_id: tenant.id, filename: input.filename?.trim().slice(0, 200) || null, row_count: rows.length, created_by: ctx.actor.label });
  const seen = new Map<string, number>();
  const lines = rows.map((r) => {
    const base = `${r.txnDate}|${r.amount}|${r.last5 ?? ""}|${r.memo ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { tenant_id: tenant.id, import_id: imp.id, txn_date: r.txnDate, amount: r.amount, last5: r.last5, memo: r.memo, fingerprint: createHash("sha256").update(`${tenant.id}|${base}|${n}`).digest("hex") };
  });
  const inserted = await ctx.store.insertBankLines(lines);
  await ctx.store.setBankImportInserted(tenant.id, imp.id, inserted.length);
  const result = await runBankMatching(ctx, tenant, settings.bankMatchWindowDays ?? GB_DEFAULT_MATCH_WINDOW_DAYS);
  await audit(ctx, tenant.id, "bank.import", { importId: imp.id, rows: rows.length, inserted: inserted.length, suggested: result.suggestions.length, ambiguous: result.ambiguous.length });
  return {
    importId: imp.id,
    rows: rows.length,
    inserted: inserted.length,
    duplicates: rows.length - inserted.length,
    ...result,
    note: "這些只是「建議配對」，訂單狀態沒有改變。請讓使用者逐筆核對後，用 confirm_bank_matches（matchIds、confirm: true）標記已付款；不對的用 rejectMatchIds 拒絕。多重候選（ambiguous）與找不到的明細不會自動配對，請人工處理。",
  };
}

async function runBankMatching(ctx: ServiceContext, tenant: TenantRow, windowDays: number) {
  const open = await ctx.store.listBankLines(tenant.id, { status: ["unmatched", "ambiguous"], limit: 2000 });
  const pending: OrderRow[] = [];
  for (let offset = 0; offset < 2000; offset += 200) {
    const r = await ctx.store.listOrders(tenant.id, { status: "pending_payment", limit: 200, offset });
    pending.push(...r.rows.filter((o) => o.payment_method === "offline"));
    if (r.rows.length < 200) break;
  }
  const active = await ctx.store.listBankMatches(tenant.id, { status: ["suggested", "confirmed"], limit: 5000 });
  const taken = new Set(active.map((m) => m.order_id));
  const rejected = new Set((await ctx.store.listBankMatches(tenant.id, { status: ["rejected"], limit: 5000 })).map((m) => `${m.line_id}|${m.order_id}`));
  const cands = pending.filter((o) => !taken.has(o.id));
  const ext = await ctx.store.listGroupBuyOrderRows(tenant.id, { orderIds: cands.map((o) => o.id) });
  const orders: MatchCandidateOrder[] = cands.map((o) => ({ id: o.id, order_no: o.order_no, total: o.total, created_at: o.created_at, payer_last5: ext.find((e) => e.order_id === o.id)?.payer_last5 ?? null }));
  const r = suggestBankMatches(open, orders, windowDays, rejected);
  const suggestions: { matchId: string; line: { date: string; amount: number; last5: string | null; memo: string | null }; orderNo: string; buyer: string; orderTotal: number }[] = [];
  for (const s of r.suggested) {
    const m = await ctx.store.insertBankMatch({ tenant_id: tenant.id, line_id: s.lineId, order_id: s.orderId });
    const l = open.find((x) => x.id === s.lineId)!;
    if (!m) {
      // 併發匯入時另一個請求先配了：當成多重候選，交給人工
      await ctx.store.setBankLineStatus(tenant.id, [s.lineId], "ambiguous");
      r.ambiguous.push({ lineId: s.lineId, orderIds: [s.orderId] });
      continue;
    }
    await ctx.store.setBankLineStatus(tenant.id, [s.lineId], "suggested");
    const o = cands.find((x) => x.id === s.orderId)!;
    suggestions.push({ matchId: m.id, line: { date: l.txn_date, amount: l.amount, last5: l.last5, memo: l.memo }, orderNo: o.order_no, buyer: maskName(o.contact.name), orderTotal: o.total });
  }
  if (r.ambiguous.length) await ctx.store.setBankLineStatus(tenant.id, r.ambiguous.map((a) => a.lineId), "ambiguous");
  return {
    suggestions,
    ambiguous: r.ambiguous.map((a) => {
      const l = open.find((x) => x.id === a.lineId)!;
      return { line: { date: l.txn_date, amount: l.amount, last5: l.last5 }, candidateOrders: a.orderIds.map((id) => cands.find((o) => o.id === id)?.order_no ?? id) };
    }),
    unmatched: r.unmatched.length,
  };
}

/**
 * 確認配對（orders:write＋confirm）：每筆在同一交易把「配對 → 已確認」與「訂單 → 已付款」一起改（builder_confirm_bank_match；
 * 一筆明細／一張單只能確認一次＝DB partial unique）。訂單已不能收款（逾期取消、已付款）→ 配對改為 rejected 並回報。成功的跑付款成功流程（寄信、分潤、發票…）。
 */
export async function confirmBankMatches(ctx: ServiceContext, input: { site?: string | null; matchIds?: string[]; rejectMatchIds?: string[]; confirm?: boolean }) {
  requireScope(ctx, "orders:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireGroupBuy(ctx, tenant);
  const ids = [...new Set(input.matchIds ?? [])].slice(0, 200);
  const rejects = [...new Set(input.rejectMatchIds ?? [])].slice(0, 200);
  if (!ids.length && !rejects.length) throw new ServiceError("invalid", "請給 matchIds（要確認的）或 rejectMatchIds（要拒絕的）");
  const matches = await ctx.store.listBankMatches(tenant.id, { ids: [...ids, ...rejects], limit: 500 });
  const pend = matches.filter((m) => ids.includes(m.id) && m.status === "suggested");
  let total = 0;
  for (const m of pend) total += (await ctx.store.getOrderById(tenant.id, m.order_id))?.total ?? 0;
  requireConfirm(input.confirm, `把 ${pend.length} 張訂單標記為已收款（銀行轉帳，共 ${twd(total)}）會通知客人並進入出貨流程${rejects.length ? `；另外拒絕 ${rejects.length} 筆建議` : ""}`);
  const results: { matchId: string; orderNo: string | null; ok: boolean; message: string }[] = [];
  for (const id of ids) {
    const m = matches.find((x) => x.id === id);
    if (!m) {
      results.push({ matchId: id, orderNo: null, ok: false, message: "找不到這筆配對" });
      continue;
    }
    try {
      const order = await ctx.store.confirmBankMatch(tenant.id, id, ctx.actor.label);
      if (!order) {
        results.push({ matchId: id, orderNo: null, ok: false, message: `這筆配對已是「${m.status}」` });
        continue;
      }
      await audit(ctx, tenant.id, "order.mark_paid", { orderNo: order.order_no, total: order.total, via: "bank_match", matchId: id });
      await onOrderPaid({ store: ctx.store, sendMail: ctx.sendMail, baseUrl: ctx.baseUrl }, tenant, order, "銀行轉帳（明細對帳，店主確認）");
      results.push({ matchId: id, orderNo: order.order_no, ok: true, message: "已標記收款" });
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : "確認失敗";
      if (e instanceof ServiceError && e.code === "conflict") {
        await ctx.store.decideBankMatch(tenant.id, id, "suggested", "rejected", { reason: msg, decided_by: ctx.actor.label });
        await ctx.store.setBankLineStatus(tenant.id, [m.line_id], "unmatched");
      } else console.error("[bank] confirm", e);
      const o = await ctx.store.getOrderById(tenant.id, m.order_id);
      results.push({ matchId: id, orderNo: o?.order_no ?? null, ok: false, message: msg });
    }
  }
  for (const id of rejects) {
    const m = matches.find((x) => x.id === id);
    if (m && (await ctx.store.decideBankMatch(tenant.id, id, "suggested", "rejected", { reason: "店主拒絕", decided_by: ctx.actor.label }))) {
      await ctx.store.setBankLineStatus(tenant.id, [m.line_id], "unmatched");
      results.push({ matchId: id, orderNo: null, ok: true, message: "已拒絕" });
    } else results.push({ matchId: id, orderNo: null, ok: false, message: "這筆配對不是建議中" });
  }
  await audit(ctx, tenant.id, "bank.confirm", { confirmed: results.filter((r) => r.ok && r.message === "已標記收款").length, rejected: rejects.length });
  return { results };
}

export { commissionFor };

const normPhone = (v: unknown) => {
  const d = typeof v === "string" ? v.normalize("NFKC").replace(/\D/g, "").replace(/^8869/, "09") : "";
  return d.length >= 8 ? d : "";
};
const normAddr = (v: unknown) => (typeof v === "string" ? v.normalize("NFKC").replace(/[\s,，、.。-]/g, "").toLowerCase() : "");

/** 第八批審查 L-2：下單的電話或收件地址與團主（或團主以前下過的單）相同 → 視為自己買自己的團 */
async function sameAsLeader(store: Store, tenant: TenantRow, leader: { phone?: string | null; email_norm: string }, d: { contact?: unknown; shipping?: unknown }): Promise<boolean> {
  const c = (d.contact ?? {}) as { phone?: unknown };
  const sh = (d.shipping ?? {}) as { phone?: unknown; address?: unknown };
  const phones = new Set([normPhone(c.phone), normPhone(sh.phone)].filter(Boolean));
  const addr = normAddr(sh.address);
  if (leader.phone && phones.has(normPhone(leader.phone))) return true;
  if (!phones.size && addr.length < 6) return false;
  // 團主自己的會員帳號（同 email）下過的訂單的電話／地址
  const member = await store.listMembers(tenant.id, { limit: 5, offset: 0, q: leader.email_norm });
  for (const m of member.rows.filter((x) => normalizeEmail(x.email) === leader.email_norm)) {
    if (m.phone && phones.has(normPhone(m.phone))) return true;
    const own = await store.listOrders(tenant.id, { memberId: m.id, limit: 20, offset: 0 });
    for (const o of own.rows) {
      if (phones.has(normPhone(o.contact.phone)) || (o.shipping && phones.has(normPhone(o.shipping.phone)))) return true;
      if (addr.length >= 6 && o.shipping && normAddr(o.shipping.address) === addr) return true;
    }
  }
  return false;
}
