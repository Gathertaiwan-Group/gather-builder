import { str } from "@/lib/adminRoute";
import { backofficeForm } from "@/lib/backoffice";
import { createAddonOrder, ownerPaymentLink, requestRenewalOrder, setRenewal } from "@/lib/services/platform-billing";
import { getMailer } from "@/lib/mail";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return backofficeForm(req, slug, "/billing", async (f, bo) => {
    const action = str(f, "action");
    if (action === "addon") {
      const r = await createAddonOrder(bo.ctx, { site: slug, modules: f.getAll("modules").map(String) }, { sendMail: getMailer() });
      return { message: `已建立加購訂單 ${r.orderNo}`, redirectTo: r.statusUrl };
    }
    if (action === "renew") {
      const r = await requestRenewalOrder(bo.ctx, { site: slug });
      return { message: "前往付款頁", redirectTo: r.statusUrl };
    }
    if (action === "pay") {
      const r = await ownerPaymentLink(bo.ctx, { site: slug, orderNo: str(f, "orderNo") });
      return { message: "前往付款頁", redirectTo: r.statusUrl };
    }
    const r = await setRenewal(bo.ctx, { site: slug, cancel: action === "cancel", confirm: f.get("confirm") === "on" });
    return { message: r.cancelAtPeriodEnd ? "已停止續費（到期後停站）" : "已恢復續費" };
  });
}
