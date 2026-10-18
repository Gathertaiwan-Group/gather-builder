import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { setReferralKol } from "@/lib/services/referral";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/marketing`, async (f) => {
    const r = await setReferralKol(adminContext(req), { site: slug, email: str(f, "email"), ratePercent: Number(str(f, "rate")) });
    return { message: `${r.email} 的推薦碼 ${r.code} 分潤 ${r.kolRatePercent}%` };
  });
}
