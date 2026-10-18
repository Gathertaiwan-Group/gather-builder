import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { loadSite, moduleActive } from "@/lib/site-loader";
import { getSessionMember } from "@/lib/services/members";
import { createReview } from "@/lib/services/reviews";
import { formObject, memberTokenFromRequest, messageOf, originOk, siteRedirect } from "@/lib/site-request";
import { clientIp } from "@/lib/client-ip";
import { hashIp } from "@/lib/services/inquiries";
import { requireSecret } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/** 會員送出商品評價（表單 POST；資格在服務層檢查） */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const slug = (await params).site.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const store = getStore();
  const site = await loadSite(slug, null, store, { lang: null });
  if (!site || !moduleActive(site, "reviews")) return new NextResponse("not found", { status: 404 });
  let back = "/shop";
  try {
    const hit = await store.rateHit(`review:${site.tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 3600, 10);
    const form = await formObject(req);
    if (/^[a-z0-9-]{1,80}$/.test(form.productSlug ?? "")) back = `/shop/${form.productSlug}`;
    if (!hit.allowed) return siteRedirect(req, slug, back, { err: "送出太頻繁，請稍後再試" });
    const member = (await getSessionMember(store, site.tenant, memberTokenFromRequest(req, site.tenant)))?.member ?? null;
    const images = (form.images ?? "").split(/\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
    const r = await createReview(store, { tenant: site.tenant, member, data: { productId: form.productId, orderId: form.orderId, rating: form.rating, body: form.body ?? "", images } });
    return siteRedirect(req, slug, back, { ok: r.status === "published" ? "謝謝你的評價！" : "謝謝你的評價！店家審核後會公開。" });
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}
