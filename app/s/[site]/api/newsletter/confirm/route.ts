import { getStore } from "@/lib/store";
import { confirmSubscription } from "@/lib/services/newsletter";
import { formObject, originOk, siteRedirect } from "@/lib/site-request";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 確認訂閱（L-3：POST 才生效，信件掃描器預先打開連結不會替人確認）：token 一次性 */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const slug = (await params).site.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const store = getStore();
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) return new NextResponse("not found", { status: 404 });
  const f = await formObject(req);
  const r = await confirmSubscription(store, tenant, f.token);
  return siteRedirect(req, slug, "/newsletter/confirm", r.ok ? { ok: r.message } : { err: r.message });
}
