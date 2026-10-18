import { z } from "zod";
import type { PersonRow, Store, TenantRow } from "../store/types";
import { imageUrl, optText, postSlug, text } from "../validators";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";

async function requireDirectory(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("directory")) throw new ServiceError("forbidden", "此網站未啟用模組「directory」，請先 enable_module directory");
}
/** 上架、修改已上架、下架都立即影響線上 → 與 publish_site 同一道門檻 */
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) throw new ServiceError("forbidden", `${what}會直接改變線上網站，需要 scope「publish」。沒有 publish 權限時請維持 draft。`);
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

export const personInput = z
  .object({
    slug: postSlug,
    name: text(80),
    title: optText(120),
    category: optText(40),
    photoUrl: imageUrl.optional(),
    bioMd: z.string().max(20_000).default(""),
    email: z.email({ message: "Email 格式不正確" }).optional(),
    phone: z.string().trim().max(40).optional(),
    website: z.string().trim().max(300).regex(/^https?:\/\//, { message: "網站需為 http(s):// 開頭" }).optional(),
    /** true 才在前台顯示聯絡方式（預設不公開） */
    showContact: z.boolean().default(false),
    status: z.enum(["draft", "published"]).default("draft"),
    sort: z.number().int().min(-10000).max(10000).default(0),
  })
  .strict();

const summary = (p: PersonRow) => ({ id: p.id, slug: p.slug, name: p.name, title: p.title, category: p.category, photoUrl: p.photo_url, showContact: p.show_contact, hasEmail: !!p.email, hasPhone: !!p.phone, status: p.status, sort: p.sort });

export async function createPerson(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof personInput>) {
  requireScope(ctx, "content:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireDirectory(ctx, tenant);
  const d = parse(personInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架人員", confirm);
  if (await ctx.store.getPersonBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `slug「${d.slug}」已存在`);
  const row = await ctx.store.insertPerson({ tenant_id: tenant.id, slug: d.slug, name: d.name, title: d.title ?? null, category: d.category ?? null, photo_url: d.photoUrl ?? null, bio_md: d.bioMd, email: d.email ?? null, phone: d.phone || null, website: d.website ?? null, show_contact: d.showContact, status: d.status, sort: d.sort });
  await audit(ctx, tenant.id, "directory.create", { personId: row.id, status: row.status });
  return { ...summary(row), note: row.status === "published" ? "已上架（立即對外）。" : "人員為草稿，status 改為 published（需 confirm）才會公開。" };
}

export async function updatePerson(ctx: ServiceContext, input: { site?: string | null; personId?: string; slug?: string; confirm?: boolean; patch: Partial<z.input<typeof personInput>> }) {
  requireScope(ctx, "content:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireDirectory(ctx, tenant);
  const cur = input.personId ? await ctx.store.getPersonById(tenant.id, input.personId) : input.slug ? await ctx.store.getPersonBySlug(tenant.id, input.slug) : null;
  if (!cur) throw new ServiceError("not_found", "找不到人員（請給 personId 或 slug）");
  const given = input.patch ?? {};
  const p = parse(personInput.partial().strict(), given);
  if (cur.status === "published" || given.status === "published") requireLiveConfirm(ctx, "修改／上架／下架已公開的人員", input.confirm);
  const patch: Partial<PersonRow> = {};
  const map: [keyof typeof given, keyof PersonRow, unknown][] = [
    ["slug", "slug", p.slug], ["name", "name", p.name], ["title", "title", p.title ?? null], ["category", "category", p.category ?? null], ["photoUrl", "photo_url", p.photoUrl ?? null],
    ["bioMd", "bio_md", p.bioMd], ["email", "email", p.email ?? null], ["phone", "phone", p.phone || null], ["website", "website", p.website ?? null], ["showContact", "show_contact", p.showContact], ["status", "status", p.status], ["sort", "sort", p.sort],
  ];
  for (const [k, col, v] of map) if (given[k] !== undefined) (patch as Record<string, unknown>)[col] = v;
  const row = (await ctx.store.updatePerson(tenant.id, cur.id, patch))!;
  await audit(ctx, tenant.id, "directory.update", { personId: row.id, keys: Object.keys(given) });
  return summary(row);
}

export async function listPeople(ctx: ServiceContext, input: { site?: string | null; status?: "draft" | "published"; category?: string }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireDirectory(ctx, tenant);
  const rows = await ctx.store.listPeople(tenant.id, { status: input.status, category: input.category });
  return { total: rows.length, categories: [...new Set(rows.map((r) => r.category).filter(Boolean))], people: rows.map(summary) };
}

/** 前台：已公開的人員；聯絡方式只在 show_contact 時給 */
export function publicPerson(p: PersonRow) {
  return { ...p, email: p.show_contact ? p.email : null, phone: p.show_contact ? p.phone : null, website: p.show_contact ? p.website : null };
}
export async function publicPeople(store: Store, tenant: TenantRow, category?: string | null) {
  return (await store.listPeople(tenant.id, { status: "published", category: category || undefined })).map(publicPerson);
}
