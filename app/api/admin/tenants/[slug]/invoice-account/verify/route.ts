import { adminContext } from "@/lib/adminServer";
import { adminForm } from "@/lib/adminRoute";
import { verifyInvoiceAccount } from "@/lib/services/invoices";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/invoices`, async () => {
    await verifyInvoiceAccount(adminContext(req), { site: slug });
    return { message: "發票憑證驗證成功" };
  });
}
