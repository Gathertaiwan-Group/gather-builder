import { backofficeForm } from "@/lib/backoffice";
import { verifyInvoiceAccount } from "@/lib/services/invoices";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/invoices", async (f, bo) => {
    await verifyInvoiceAccount(bo.ctx, { site: slug });
    return { message: "發票憑證驗證成功" };
  });
}
