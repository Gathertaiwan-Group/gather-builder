import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { createCoupon, updateCoupon } from "@/lib/services/coupons";

export const dynamic = "force-dynamic";

const num = (v: string) => (v ? Number(v) : undefined);
const iso = (v: string) => (v ? new Date(`${v}:00+08:00`).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined);

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/marketing`, async (f) => {
    const ctx = adminContext(req);
    if (str(f, "action") === "toggle") {
      const r = await updateCoupon(ctx, { site: slug, code: str(f, "code"), active: str(f, "active") === "1" });
      return { message: `折扣碼 ${r.code} 已${r.active ? "啟用" : "停用"}` };
    }
    const r = await createCoupon(ctx, {
      site: slug,
      code: str(f, "code"),
      kind: str(f, "kind") === "percent" ? "percent" : "fixed",
      value: Number(str(f, "value")),
      maxDiscount: num(str(f, "maxDiscount")),
      minSubtotal: num(str(f, "minSubtotal")) ?? 0,
      startsAt: iso(str(f, "startsAt")),
      endsAt: iso(str(f, "endsAt")),
      maxUses: num(str(f, "maxUses")),
      perUserLimit: num(str(f, "perUserLimit")),
    });
    return { message: `已建立折扣碼 ${r.code}` };
  });
}
