import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { setReferralKol } from "@/lib/services/referral";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/marketing", async (f, bo) => {
    const r = await setReferralKol(bo.ctx, { site: slug, email: str(f, "email"), ratePercent: Number(str(f, "rate")) });
    return { message: `${r.email} 的推薦碼 ${r.code} 分潤 ${r.kolRatePercent}%` };
  });
}
