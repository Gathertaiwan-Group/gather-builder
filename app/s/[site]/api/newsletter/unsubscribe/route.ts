import { getStore } from "@/lib/store";
import { unsubscribe } from "@/lib/services/newsletter";
import { formObject, originOk, siteRedirect } from "@/lib/site-request";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 退訂（POST，避免信件掃描器打開連結就退訂）：token 一次性 */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const slug = (await params).site.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const store = getStore();
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) return new NextResponse("not found", { status: 404 });
  const f = await formObject(req);
  const r = await unsubscribe(store, tenant, f.t);
  return siteRedirect(req, slug, "/newsletter/unsubscribe", r.ok ? { ok: r.message } : { err: r.message });
}
