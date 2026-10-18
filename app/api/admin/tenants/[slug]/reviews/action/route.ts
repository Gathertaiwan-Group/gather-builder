import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { moderateReview, replyReview } from "@/lib/services/reviews";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/reviews`, async (f) => {
    const ctx = adminContext(req);
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
