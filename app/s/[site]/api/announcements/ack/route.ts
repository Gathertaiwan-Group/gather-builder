import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { loadSite, moduleActive } from "@/lib/site-loader";
import { getSessionMember } from "@/lib/services/members";
import { acknowledgeAnnouncement } from "@/lib/services/announcements";
import { formObject, memberTokenFromRequest, messageOf, originOk, safeNext, siteRedirect } from "@/lib/site-request";

export const dynamic = "force-dynamic";

/** 會員確認必讀公告（表單 POST；只記第一次，只增不改） */
export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const slug = (await params).site.toLowerCase();
  if (!originOk(req)) return new NextResponse("forbidden origin", { status: 403 });
  const store = getStore();
  const site = await loadSite(slug, null, store, { lang: null });
  if (!site || !moduleActive(site, "announcements")) return new NextResponse("not found", { status: 404 });
  let back = "/announcements";
  try {
    const form = await formObject(req);
    back = safeNext(form.back, "/announcements");
    const member = (await getSessionMember(store, site.tenant, memberTokenFromRequest(req, site.tenant)))?.member ?? null;
    await acknowledgeAnnouncement(store, { tenant: site.tenant, member, announcementId: form.id ?? "" });
    return siteRedirect(req, slug, back, { ok: "已確認，謝謝。" });
  } catch (e) {
    return siteRedirect(req, slug, back, { err: messageOf(e) });
  }
}
