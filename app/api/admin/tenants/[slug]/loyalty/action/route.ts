import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { adjustPoints } from "@/lib/services/loyalty";
import { adjustBalance } from "@/lib/services/wallet";
import { setAdjustLimits } from "@/lib/services/adjust-limits";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/loyalty`, async (f) => {
    const ctx = adminContext(req);
    if (str(f, "action") === "limits") {
      const r = await setAdjustLimits(ctx, { site: slug, ledger: str(f, "ledger") === "wallet" ? "wallet" : "points", perCall: Number(str(f, "perCall")), perDay: Number(str(f, "perDay")) });
      return { message: `${r.ledger === "wallet" ? "儲值金" : "點數"}手動調整上限：單次 ${r.perCall}、每日 ${r.perDay}` };
    }
    const input = { site: slug, email: str(f, "email"), amount: Number(str(f, "amount")), reason: str(f, "reason"), confirm: f.get("confirm") === "on" };
    if (str(f, "ledger") === "wallet") {
      const r = await adjustBalance(ctx, input);
      return { message: `已調整儲值金 ${r.adjusted}，餘額 NT$${r.balance}` };
    }
    const r = await adjustPoints(ctx, input);
    return { message: `已調整點數 ${r.adjusted}，餘額 ${r.balance} 點` };
  });
}
