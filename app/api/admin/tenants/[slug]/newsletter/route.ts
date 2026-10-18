import { adminContext } from "@/lib/adminServer";
import { adminForm, str } from "@/lib/adminRoute";
import { createBroadcast, sendBroadcast, sendTestBroadcast } from "@/lib/services/newsletter";
import { ServiceError } from "@/lib/services/context";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return adminForm(req, `/admin/t/${slug}/newsletter`, async (f) => {
    const ctx = adminContext(req);
    const action = str(f, "action");
    if (action === "create") {
      const r = await createBroadcast(ctx, { site: slug, subject: str(f, "subject"), bodyMd: str(f, "bodyMd") });
      return { message: `已建立草稿「${r.subject}」` };
    }
    if (action === "test") {
      const r = await sendTestBroadcast(ctx, { site: slug, broadcastId: str(f, "broadcastId"), to: str(f, "to") });
      return { message: `${r.note}（${r.to}）` };
    }
    if (action === "send") {
      const r = await sendBroadcast(ctx, { site: slug, broadcastId: str(f, "broadcastId"), confirm: f.get("confirm") === "on" });
      return { message: `本批寄出 ${r.thisBatch.sent}、失敗 ${r.thisBatch.failed}、略過 ${r.thisBatch.skipped}。${r.note}` };
    }
    throw new ServiceError("invalid", "未知動作");
  });
}
