import { ctxFor } from "./helpers";
import { createSite } from "@/lib/services/sites";
import { configureModule } from "@/lib/services/modules";
import { publishSite } from "@/lib/services/publish";
import { createProduct } from "@/lib/services/shop";
import type { Store } from "@/lib/store/types";

/** 建一個已發布的商店：線下匯款開、店主信箱、運費 80 滿 1000 免運；商品 mug（庫存 5）、tee（M×2、L×1 規格） */
export async function makeShop(store: Store, slug: string, settings: Record<string, unknown> = {}) {
  const ctx = ctxFor(store);
  await createSite(ctx, { slug, name: `店 ${slug}`, modules: ["sections-basic", "shop"] });
  await configureModule(ctx, { site: slug, moduleId: "shop", config: { offlineTransfer: { enabled: true, instructions: "請匯款至 000-123" }, ownerEmail: "owner@example.com", shippingFee: 80, freeShippingThreshold: 1000, ...settings } });
  await publishSite(ctx, { site: slug, confirm: true });
  const tenant = (await store.getTenantBySlug(slug))!;
  const p1 = await createProduct(ctx, { site: slug, slug: "mug", name: "馬克杯", price: 350, trackInventory: true, stock: 5, status: "published", confirm: true });
  const p2 = await createProduct(ctx, { site: slug, slug: "tee", name: "T 恤", price: 600, trackInventory: true, stock: 0, status: "published", confirm: true, variants: [{ options: { 尺寸: "M" }, stock: 2 }, { options: { 尺寸: "L" }, price: 650, stock: 1 }] });
  return { ctx, tenant, mug: p1, tee: p2 };
}
