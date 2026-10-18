import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { adjustPoints } from "@/lib/services/loyalty";
import { adjustBalance } from "@/lib/services/wallet";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/loyalty`, async (f) => {
    const ctx = adminContext(req);
    const input = { site: slug, email: str(f, "email"), amount: Number(str(f, "amount")), reason: str(f, "reason"), confirm: f.get("confirm") === "on" };
    if (str(f, "ledger") === "wallet") {
      const r = await adjustBalance(ctx, input);
      return { message: `已調整儲值金 ${r.adjusted}，餘額 NT$${r.balance}` };
    }
    const r = await adjustPoints(ctx, input);
    return { message: `已調整點數 ${r.adjusted}，餘額 ${r.balance} 點` };
  });
}
