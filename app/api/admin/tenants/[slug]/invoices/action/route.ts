import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { issueInvoice, retryInvoice, voidInvoice } from "@/lib/services/invoices";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/invoices", async (f, bo) => {
    const ctx = bo.ctx;
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
