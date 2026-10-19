import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { moderateReview, replyReview } from "@/lib/services/reviews";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/reviews", async (f, bo) => {
    const ctx = bo.ctx;
    const confirm = f.get("confirm") === "on";
    const action = str(f, "action");
    if (action === "reply") {
      await replyReview(ctx, { site: slug, reviewId: str(f, "reviewId"), reply: str(f, "reply"), confirm });
      return { message: "已回覆" };
    }
    const r = await moderateReview(ctx, { site: slug, reviewId: str(f, "reviewId"), action: action === "hide" ? "hide" : "publish", confirm });
    return { message: r.status === "published" ? "已公開" : "已隱藏" };
  });
}
