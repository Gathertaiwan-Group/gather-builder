import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { issueInvoice, retryInvoice, voidInvoice } from "@/lib/services/invoices";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/invoices`, async (f) => {
    const ctx = adminContext(req);
    const base = { site: slug, orderNo: str(f, "orderNo"), confirm: f.get("confirm") === "on" };
    const action = str(f, "action");
    if (action === "issue") return { message: (await issueInvoice(ctx, base)).note };
    if (action === "retry") return { message: (await retryInvoice(ctx, base)).note };
    if (action === "void") {
      const amt = str(f, "allowanceAmount");
      return { message: (await voidInvoice(ctx, { ...base, reason: str(f, "reason") || undefined, allowanceAmount: amt ? Number(amt) : undefined })).note };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
