import { randomBytes } from "node:crypto";
import { z } from "zod";
import { shopSettings, type ShopSettings } from "@/modules/shop/manifest";
import { imageUrl, optText, postSlug, text } from "../validators";
import type { MemberRow, OrderItemInput, OrderRow, PaymentMethod, ProductRow, Store, TenantRow, VariantRow } from "../store/types";
import { PCHOMEPAY_MIN_AMOUNT } from "../pay/pchomepay";
import { ServiceError, activeModuleIds, audit, moduleStates, requireScope, resolveTenant, type ServiceContext } from "./context";
import { parse } from "./sites";
import { publishedModuleSettings, sha256 } from "./members";

/* ================================================================== 共用 */

export async function requireShop(ctx: Pick<ServiceContext, "store">, tenant: TenantRow) {
  if (!activeModuleIds(await moduleStates(ctx, tenant.id)).has("shop")) {
    throw new ServiceError("forbidden", "此網站未啟用模組「shop」，請先 enable_module shop");
  }
}

export async function publishedShopSettings(store: Store, tenant: TenantRow): Promise<ShopSettings> {
  return (await publishedModuleSettings(store, tenant, "shop")) as ShopSettings;
}

/** 商品上架、修改已上架商品、下架都會立即影響線上 → 與 publish_site 同一道門檻 */
function requireLiveConfirm(ctx: ServiceContext, what: string, confirm: boolean | undefined) {
  if (!ctx.actor.scopes.includes("publish")) {
    throw new ServiceError("forbidden", `${what}會直接改變線上商店，需要 scope「publish」。沒有 publish 權限時請用 status: "draft"，再請有權限的人上架。`);
  }
  if (confirm !== true) throw new ServiceError("confirm_required", `${what}會立即對外生效。請先讓使用者確認，再以 confirm: true 呼叫。`);
}

export function defaultOrderPrefix(slug: string): string {
  const p = slug.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
  return p.length >= 2 ? p : "GB";
}

/** 台北時間 YYYYMMDD（訂單編號用） */
export function taipeiDay(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");
}

/** 單筆訂單上限（避免 int 溢位；也低於一般金流單筆上限） */
export const MAX_ORDER_TOTAL = 2_000_000;

export const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/* ================================================================== 商品 */

const variantInput = z
  .object({
    options: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(60)),
    price: z.number().int().min(0).max(10_000_000).optional(),
    sku: optText(64),
    stock: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export const productInput = z
  .object({
    slug: postSlug,
    name: text(160),
    descriptionMd: z.string().max(50_000).default(""),
    images: z.array(imageUrl).max(10).default([]),
    price: z.number().int().min(0).max(10_000_000),
    compareAtPrice: z.number().int().min(0).max(10_000_000).nullable().optional(),
    sku: optText(64),
    trackInventory: z.boolean().default(false),
    stock: z.number().int().min(0).max(1_000_000).default(0),
    sort: z.number().int().min(-10000).max(10000).default(0),
    status: z.enum(["draft", "published"]).default("draft"),
    variants: z.array(variantInput).max(50).optional(),
  })
  .strict();

function productSummary(p: ProductRow, variants: VariantRow[] = []) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    status: p.status,
    price: p.price,
    compareAtPrice: p.compare_at_price,
    sku: p.sku,
    trackInventory: p.track_inventory,
    stock: p.stock,
    sort: p.sort,
    images: p.images,
    variants: variants.map((v) => ({ id: v.id, options: v.options, price: v.price, sku: v.sku, stock: v.stock })),
  };
}

export async function createProduct(ctx: ServiceContext, input: { site?: string | null; confirm?: boolean } & z.input<typeof productInput>) {
  requireScope(ctx, "commerce:write");
  const { site, confirm, ...rest } = input;
  const tenant = await resolveTenant(ctx, site);
  await requireShop(ctx, tenant);
  const d = parse(productInput, rest);
  if (d.status === "published") requireLiveConfirm(ctx, "直接上架商品", confirm);
  if (await ctx.store.getProductBySlug(tenant.id, d.slug)) throw new ServiceError("conflict", `商品 slug「${d.slug}」已存在，請用 update_product 或換 slug`);
  const row = await ctx.store.insertProduct({
    tenant_id: tenant.id,
    slug: d.slug,
    name: d.name,
    description_md: d.descriptionMd,
    images: d.images,
    status: d.status,
    price: d.price,
    compare_at_price: d.compareAtPrice ?? null,
    sku: d.sku ?? null,
    track_inventory: d.trackInventory,
    stock: d.stock,
    sort: d.sort,
  });
  const variants = d.variants?.length
    ? await ctx.store.replaceVariants(tenant.id, row.id, d.variants.map((v, i) => ({ options: v.options, price: v.price ?? null, sku: v.sku ?? null, stock: v.stock, sort: i })))
    : [];
  await audit(ctx, tenant.id, "product.create", { productId: row.id, slug: row.slug, status: row.status });
  return { ...productSummary(row, variants), note: row.status === "published" ? "商品已上架（立即對外）。" : "商品為草稿，status 改為 published 才會上架。" };
}

export async function updateProduct(
  ctx: ServiceContext,
  input: { site?: string | null; productId?: string; slug?: string; confirm?: boolean; expectedStock?: number; patch: Partial<z.input<typeof productInput>> },
) {
  requireScope(ctx, "commerce:write");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const existing = input.productId
    ? await ctx.store.getProductById(tenant.id, input.productId)
    : input.slug
      ? await ctx.store.getProductBySlug(tenant.id, input.slug)
      : null;
  if (!existing) throw new ServiceError("not_found", "找不到商品（請給 productId 或 slug）");
  const given = input.patch ?? {};
  const p = parse(productInput.partial().strict(), given);
  const nextStatus = given.status ?? existing.status;
  if (existing.status === "published" || nextStatus === "published") requireLiveConfirm(ctx, "修改／上架／下架已上架的商品", input.confirm);
  if (p.slug && p.slug !== existing.slug && (await ctx.store.getProductBySlug(tenant.id, p.slug))) throw new ServiceError("conflict", `商品 slug「${p.slug}」已存在`);
  // 庫存是絕對值：帶 expectedStock 時若期間有人下單（庫存已變）就拒絕，避免把剛扣掉的庫存蓋回去
  if (given.stock !== undefined && input.expectedStock !== undefined && existing.stock !== input.expectedStock) {
    throw new ServiceError("conflict", `「${existing.name}」的庫存在你讀取後已變動（目前 ${existing.stock}，你讀到的是 ${input.expectedStock}），請重新讀取後再改`);
  }
  const patch: Partial<ProductRow> = {};
  if (given.slug !== undefined) patch.slug = p.slug;
  if (given.name !== undefined) patch.name = p.name;
  if (given.descriptionMd !== undefined) patch.description_md = p.descriptionMd;
  if (given.images !== undefined) patch.images = p.images;
  if (given.price !== undefined) patch.price = p.price;
  if (given.compareAtPrice !== undefined) patch.compare_at_price = p.compareAtPrice ?? null;
  if (given.sku !== undefined) patch.sku = p.sku ?? null;
  if (given.trackInventory !== undefined) patch.track_inventory = p.trackInventory;
  if (given.stock !== undefined) patch.stock = p.stock;
  if (given.sort !== undefined) patch.sort = p.sort;
  if (given.status !== undefined) patch.status = p.status;
  const row = Object.keys(patch).length ? await ctx.store.updateProduct(tenant.id, existing.id, patch) : existing;
  let variants: VariantRow[];
  if (p.variants !== undefined) {
    variants = await ctx.store.replaceVariants(tenant.id, existing.id, p.variants.map((v, i) => ({ options: v.options, price: v.price ?? null, sku: v.sku ?? null, stock: v.stock, sort: i })));
  } else {
    variants = await ctx.store.listVariants(tenant.id, [existing.id]);
  }
  await audit(ctx, tenant.id, "product.update", { productId: row.id, keys: Object.keys(given) });
  return productSummary(row, variants);
}

export async function listProducts(ctx: ServiceContext, input: { site?: string | null; status?: "draft" | "published"; limit?: number; offset?: number }) {
  requireScope(ctx, "site:read");
  const tenant = await resolveTenant(ctx, input.site);
  await requireShop(ctx, tenant);
  const lim = Math.max(1, Math.min(100, input.limit ?? 50));
  const r = await ctx.store.listProducts(tenant.id, { status: input.status, limit: lim, offset: Math.max(0, input.offset ?? 0) });
  const variants = await ctx.store.listVariants(tenant.id, r.rows.map((x) => x.id));
  return { total: r.total, products: r.rows.map((x) => productSummary(x, variants.filter((v) => v.product_id === x.id))) };
}

/** 前台讀取：只回已上架商品（含規格） */
export async function publicProducts(store: Store, tenantId: string, limit: number) {
  const r = await store.listProducts(tenantId, { status: "published", limit, offset: 0 });
  const variants = await store.listVariants(tenantId, r.rows.map((x) => x.id));
  return r.rows.map((p) => ({ product: p, variants: variants.filter((v) => v.product_id === p.id) }));
}

export function variantLabel(v: VariantRow | undefined): string | null {
  if (!v) return null;
  return Object.values(v.options).join(" / ") || null;
}

/* ================================================================== 計價（server 端權威） */

// 刻意不用 strict：前端多送的欄位（例如被竄改的 price／total）直接丟掉，價格只從 DB 讀
export const cartLineInput = z.object({
  productId: z.string().trim().min(1).max(64),
  variantId: z.string().trim().max(64).nullable().optional(),
  qty: z.number().int().min(1).max(99),
});
export const cartInput = z.array(cartLineInput).min(1, { message: "購物車是空的" }).max(30);

export interface PricedCart {
  lines: (OrderItemInput & { stockAvailable: number | null; slug: string })[];
  subtotal: number;
  shippingFee: number;
  total: number;
  problems: string[];
}

/**
 * 依 DB 重新計價：前端送來的只有「哪個商品、哪個規格、幾件」，價格一律從 DB 讀。
 * 同一品項重複出現會合併。庫存只做友善提示，權威檢查在 builder_place_order（原子扣庫存）。
 */
export async function priceCart(store: Store, tenantId: string, raw: unknown, settings: ShopSettings): Promise<PricedCart> {
  const items = parse(cartInput, raw);
  const merged = new Map<string, { productId: string; variantId: string | null; qty: number }>();
  for (const it of items) {
    const k = `${it.productId}|${it.variantId ?? ""}`;
    const prev = merged.get(k);
    merged.set(k, { productId: it.productId, variantId: it.variantId || null, qty: Math.min(99, (prev?.qty ?? 0) + it.qty) });
  }
  const ids = [...new Set([...merged.values()].map((m) => m.productId))];
  const [products, variants] = await Promise.all([store.getProductsByIds(tenantId, ids), store.listVariants(tenantId, ids)]);
  const problems: string[] = [];
  const lines: PricedCart["lines"] = [];
  for (const m of merged.values()) {
    const p = products.find((x) => x.id === m.productId);
    if (!p || p.status !== "published") {
      problems.push("購物車中有已下架或不存在的商品，已移除");
      continue;
    }
    const own = variants.filter((v) => v.product_id === p.id);
    let v: VariantRow | undefined;
    if (own.length) {
      v = own.find((x) => x.id === m.variantId);
      if (!v) {
        problems.push(`「${p.name}」請選擇規格`);
        continue;
      }
    } else if (m.variantId) {
      problems.push(`「${p.name}」沒有這個規格`);
      continue;
    }
    const unit = v?.price ?? p.price;
    const avail = p.track_inventory ? (v ? v.stock : p.stock) : null;
    if (avail !== null && m.qty > avail) problems.push(`「${p.name}${v ? `（${variantLabel(v)}）` : ""}」庫存不足（剩 ${avail} 件）`);
    lines.push({
      product_id: p.id,
      variant_id: v?.id ?? null,
      name: p.name,
      variant_label: variantLabel(v),
      sku: v?.sku ?? p.sku,
      unit_price: unit,
      qty: m.qty,
      line_total: unit * m.qty,
      stockAvailable: avail,
      slug: p.slug,
    });
  }
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  if (subtotal > MAX_ORDER_TOTAL) throw new ServiceError("invalid", `單筆訂單金額上限為 ${twd(MAX_ORDER_TOTAL)}，請分開下單`);
  const threshold = settings.freeShippingThreshold;
  const shippingFee = lines.length === 0 ? 0 : threshold !== undefined && subtotal >= threshold ? 0 : (settings.shippingFee ?? 0);
  return { lines, subtotal, shippingFee, total: subtotal + shippingFee, problems };
}

/* ================================================================== 結帳 */

export const checkoutInput = z
  .object({
    items: cartInput,
    contact: z.object({ name: text(80), email: z.string().trim().toLowerCase().max(200).pipe(z.email({ message: "Email 格式不正確" })), phone: z.string().trim().min(6, { message: "請填寫電話" }).max(40) }).strict(),
    shipping: z.object({ name: text(80), phone: z.string().trim().min(6, { message: "請填寫收件人電話" }).max(40), address: text(300) }).strict(),
    note: optText(500),
    paymentMethod: z.enum(["pchomepay", "offline"]),
  })
  .strict();

export interface PaymentAvailability {
  pchomepay: boolean;
  offline: boolean;
  offlineInstructions: string | null;
  pchomepaySandbox: boolean;
}

export async function paymentAvailability(store: Store, tenant: TenantRow, settings: ShopSettings): Promise<PaymentAvailability> {
  const acct = await store.getPaymentAccount(tenant.id, "pchomepay");
  return {
    pchomepay: settings.pchomepay !== false && acct?.status === "verified",
    pchomepaySandbox: !!acct?.sandbox,
    offline: !!settings.offlineTransfer?.enabled,
    offlineInstructions: settings.offlineTransfer?.instructions ?? null,
  };
}

export interface CheckoutDeps {
  store: Store;
  sendMail?: (to: string, subject: string, text: string) => Promise<void>;
  baseUrl: string;
}

/**
 * 建立訂單（尚未付款）。順序：驗證輸入 → 依 DB 重新計價 → 檢查付款方式 → 原子下單（扣庫存）→ 寄下單確認信。
 * 回傳 accessKey 原文（只出現在訂單頁網址；DB 只存 sha256）。
 */
export async function placeOrder(
  deps: CheckoutDeps,
  input: { tenant: TenantRow; member: MemberRow | null; data: unknown; settings?: ShopSettings },
): Promise<{ order: OrderRow; accessKey: string; orderUrl: string }> {
  const { tenant, member } = input;
  const settings = input.settings ?? (await publishedShopSettings(deps.store, tenant));
  if (settings.allowGuestCheckout === false && !member) throw new ServiceError("unauthorized", "此商店需要先登入會員才能結帳");
  const d = parse(checkoutInput, input.data);
  const priced = await priceCart(deps.store, tenant.id, d.items, settings);
  if (priced.problems.length || !priced.lines.length) throw new ServiceError("invalid", priced.problems.join("；") || "購物車是空的");

  const avail = await paymentAvailability(deps.store, tenant, settings);
  const method: PaymentMethod = d.paymentMethod;
  if (method === "pchomepay") {
    if (!avail.pchomepay) throw new ServiceError("invalid", "此商店目前無法使用線上付款，請選擇其他付款方式");
    if (priced.total < PCHOMEPAY_MIN_AMOUNT) throw new ServiceError("invalid", `線上付款最低金額為 NT$${PCHOMEPAY_MIN_AMOUNT}，請改用其他付款方式或加購商品`);
  } else if (!avail.offline) {
    throw new ServiceError("invalid", "此商店未開放線下匯款");
  }

  const accessKey = randomBytes(24).toString("base64url");
  const hours = settings.orderExpireHours ?? 72;
  const { id } = await deps.store.placeOrder(
    tenant.id,
    {
      order_prefix: settings.orderPrefix ?? defaultOrderPrefix(tenant.slug),
      member_id: member?.id ?? null,
      contact: d.contact,
      shipping: d.shipping,
      subtotal: priced.subtotal,
      shipping_fee: priced.shippingFee,
      total: priced.total,
      payment_method: method,
      expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
      access_key_hash: sha256(accessKey),
      note: d.note ?? null,
    },
    priced.lines.map(({ stockAvailable: _s, slug: _g, ...l }) => l),
    taipeiDay(),
  );
  const order = (await deps.store.getOrderById(tenant.id, id))!;
  const orderUrl = orderPageUrl(deps.baseUrl, tenant, order.order_no, accessKey);
  await deps.store.insertAudit({ tenant_id: tenant.id, actor: member ? `member:${member.id}` : "guest", action: "order.place", payload: { orderNo: order.order_no, total: order.total, method } });

  // 線上付款：等金流建單成功後才寄（建單失敗訂單會被取消，不能先寄「訂單成立」）
  if (method === "offline") await sendOrderPlacedMails(deps, tenant, order, settings, orderUrl);
  return { order, accessKey, orderUrl };
}

export async function sendOrderPlacedMails(deps: CheckoutDeps, tenant: TenantRow, order: OrderRow, settings: ShopSettings, orderUrl: string) {
  const method = order.payment_method;
  const hours = settings.orderExpireHours ?? 72;
  const offlineInstructions = settings.offlineTransfer?.instructions ?? null;
  const lines = order.items.map((l) => `・${l.name}${l.variant_label ? `（${l.variant_label}）` : ""} × ${l.qty}　${twd(l.line_total)}`).join("\n");
  const sum = `${lines}\n小計 ${twd(order.subtotal)}　運費 ${twd(order.shipping_fee)}　總計 ${twd(order.total)}`;
  const payText =
    method === "offline"
      ? `付款方式：線下匯款\n${offlineInstructions ?? "店家將與你聯繫付款方式。"}\n請於 ${hours} 小時內完成付款，逾期訂單會自動取消。`
      : "付款方式：線上付款（PChomePay 支付連）。請在付款頁完成付款；未完成付款的訂單會在期限後自動取消。";
  await mailSafe(deps, order.contact.email, `【${tenant.name}】訂單成立 ${order.order_no}`, `${order.contact.name} 你好，\n\n已收到你的訂單 ${order.order_no}：\n${sum}\n\n${payText}\n\n訂單狀態：${orderUrl}`);
  if (settings.ownerEmail) {
    await mailSafe(deps, settings.ownerEmail, `【${tenant.name}】新訂單 ${order.order_no}（${twd(order.total)}，${method === "offline" ? "線下匯款" : "線上付款"}）`, `${sum}\n\n訂購人：${order.contact.name} ${order.contact.email} ${order.contact.phone}\n收件：${order.shipping.name} ${order.shipping.phone} ${order.shipping.address}\n備註：${order.note ?? "-"}`);
  }
}

export function orderPageUrl(baseUrl: string, tenant: Pick<TenantRow, "slug">, orderNo: string, accessKey?: string) {
  return `${baseUrl.replace(/\/$/, "")}/s/${tenant.slug}/orders/${encodeURIComponent(orderNo)}${accessKey ? `?k=${encodeURIComponent(accessKey)}` : ""}`;
}

export async function mailSafe(deps: { sendMail?: CheckoutDeps["sendMail"] }, to: string, subject: string, body: string) {
  if (!deps.sendMail) {
    console.log(`[shop] RESEND_API_KEY 未設定，未寄出「${subject}」`);
    return;
  }
  try {
    await deps.sendMail(to, subject, body);
  } catch (e) {
    console.error("[shop] 寄信失敗", subject, e instanceof Error ? e.message : e);
  }
}

/** 前台訂單頁存取：網址上的 key 相符，或目前登入的會員就是下單會員 */
export function canViewOrder(order: OrderRow, accessKey: string | null | undefined, member: MemberRow | null): boolean {
  if (member && order.member_id === member.id) return true;
  return !!accessKey && sha256(accessKey) === order.access_key_hash;
}

export const shopSettingsSchema = shopSettings;
export type { ShopSettings };
