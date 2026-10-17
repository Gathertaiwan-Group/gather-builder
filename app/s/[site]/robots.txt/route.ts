import { loadSite } from "@/lib/site-loader";
import { baseUrlFrom } from "@/lib/runtime";
import { resolveSiteSlug } from "@/lib/tenant-resolve";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const slug = resolveSiteSlug({ pathSlug: (await params).site });
  const site = slug ? await loadSite(slug) : null;
  if (!site) return new Response("Not found", { status: 404 });
  const base = `${baseUrlFrom(req)}/s/${site.tenant.slug}`;
  const body = site.tenant.is_test
    ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
