import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { createProduct } from "@/lib/services/shop";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/products`, async (f) => {
    const image = str(f, "image");
    const r = await createProduct(adminContext(req), {
      site: slug,
      slug: str(f, "slug"),
      name: str(f, "name"),
      price: Number(str(f, "price")),
      stock: str(f, "stock") ? Number(str(f, "stock")) : 0,
      trackInventory: f.get("trackInventory") === "on",
      descriptionMd: str(f, "descriptionMd"),
      images: image ? [image] : [],
      status: str(f, "status") === "published" ? "published" : "draft",
      confirm: f.get("confirm") === "on",
    });
    return { message: `已新增商品「${r.name}」（${r.status === "published" ? "已上架" : "草稿"}）` };
  });
}
