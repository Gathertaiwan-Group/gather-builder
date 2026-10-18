import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { updateProduct } from "@/lib/services/shop";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/products`, async (f) => {
    const r = await updateProduct(adminContext(req), {
      site: slug,
      productId: str(f, "productId"),
      confirm: f.get("confirm") === "on",
      patch: {
        price: Number(str(f, "price")),
        stock: Number(str(f, "stock") || 0),
        trackInventory: f.get("trackInventory") === "on",
        status: str(f, "status") === "published" ? "published" : "draft",
      },
    });
    return { message: `已更新「${r.name}」` };
  });
}
