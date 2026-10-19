import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { updateProduct } from "@/lib/services/shop";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/products", async (f, bo) => {
    const patch: Record<string, unknown> = {};
    const price = Number(str(f, "price"));
    const stock = Number(str(f, "stock") || 0);
    const track = f.get("trackInventory") === "on";
    const status = str(f, "status") === "published" ? "published" : "draft";
    if (String(price) !== str(f, "origPrice")) patch.price = price;
    if (String(stock) !== str(f, "origStock")) patch.stock = stock;
    if (track !== (str(f, "origTrack") === "on")) patch.trackInventory = track;
    if (status !== str(f, "origStatus")) patch.status = status;
    if (!Object.keys(patch).length) return { message: "沒有變更" };
    const r = await updateProduct(bo.ctx, {
      site: slug,
      productId: str(f, "productId"),
      confirm: f.get("confirm") === "on",
      expectedStock: patch.stock !== undefined ? Number(str(f, "origStock")) : undefined,
      patch,
    });
    return { message: `已更新「${r.name}」` };
  });
}
