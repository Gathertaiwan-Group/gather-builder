import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { cancelSubscription, createSubscriptionPlan, updateSubscriptionPlan } from "@/lib/services/subscriptions";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/subscriptions`, async (f) => {
    const ctx = adminContext(req);
    const confirm = f.get("confirm") === "on";
    const action = str(f, "action");
    if (action === "create_plan") {
      const courseId = str(f, "courseId");
      const r = await createSubscriptionPlan(ctx, {
        site: slug,
        name: str(f, "name"),
        amount: Number(str(f, "amount")),
        interval: str(f, "interval") === "year" ? "year" : "month",
        trialDays: Number(str(f, "trialDays") || 0),
        totalPeriods: Number(str(f, "totalPeriods") || 99),
        entitlement: courseId ? { kind: "course", courseId } : { kind: "none" },
        description: str(f, "description") || undefined,
        status: f.get("activate") === "on" ? "active" : "draft",
        confirm,
      });
      return { message: `已建立方案「${r.name}」。${r.note}` };
    }
    if (action === "plan_status") {
      const status = str(f, "status") as "draft" | "active" | "archived";
      const r = await updateSubscriptionPlan(ctx, { site: slug, planId: str(f, "planId"), status, confirm });
      return { message: `方案「${r.name}」已改為 ${r.status}` };
    }
    if (action === "cancel") {
      const r = await cancelSubscription(ctx, { site: slug, subscriptionId: str(f, "subscriptionId"), confirm });
      return { message: r.message };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
