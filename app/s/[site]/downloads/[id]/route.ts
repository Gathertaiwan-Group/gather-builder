import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { getFileStorage } from "@/lib/storage/files";
import { loadSite, moduleActive } from "@/lib/site-loader";
import { getSessionMember } from "@/lib/services/members";
import { downloadDocument } from "@/lib/services/downloads";
import { memberTokenFromRequest, siteRedirect } from "@/lib/site-request";
import { ServiceError } from "@/lib/errors";
import { clientIp } from "@/lib/client-ip";
import { hashIp } from "@/lib/services/inquiries";
import { requireSecret } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/** 下載：伺服器檢查權限（限會員的文件要有效的會員 session）→ 計次 → 302 到 60 秒簽名網址 */
export async function GET(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site: raw, id } = await params;
  const slug = raw.toLowerCase();
  const store = getStore();
  const site = await loadSite(slug, null, store, { lang: null });
  if (!site || !moduleActive(site, "downloads")) return new NextResponse("not found", { status: 404 });
  const hit = await store.rateHit(`download:${site.tenant.id}`, hashIp(clientIp(req), requireSecret("PREVIEW_SECRET")), 600, 120);
  if (!hit.allowed) return new NextResponse("too many requests", { status: 429 });
  try {
    const member = (await getSessionMember(store, site.tenant, memberTokenFromRequest(req, site.tenant)))?.member ?? null;
    const r = await downloadDocument(store, getFileStorage(), { tenant: site.tenant, documentId: id, member });
    const res = NextResponse.redirect(r.url, 302);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  } catch (e) {
    if (e instanceof ServiceError && e.code === "unauthorized") return siteRedirect(req, slug, `/account/login`, { err: e.message }, { next: "/downloads" });
    if (e instanceof ServiceError) return new NextResponse(e.message, { status: 404 });
    console.error(e);
    return new NextResponse("error", { status: 500 });
  }
}
