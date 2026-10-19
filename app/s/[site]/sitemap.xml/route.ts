import { loadSite, moduleActive } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { resolveSiteSlug } from "@/lib/tenant-resolve";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const slug = resolveSiteSlug({ pathSlug: (await params).site });
  const site = slug ? await loadSite(slug) : null;
  if (!site) return new Response("Not found", { status: 404 });
  const base = site.canonicalBase;
  const urls = site.content.pages.map((p) => ({ loc: `${base}${p.path === "/" ? "" : p.path}`, lastmod: undefined as string | undefined }));
  if (moduleActive(site, "blog")) {
    urls.push({ loc: `${base}/blog`, lastmod: undefined });
    const { rows } = await getStore().listPosts(site.tenant.id, { status: "published", limit: 500, offset: 0, publishedBefore: new Date().toISOString() });
    for (const p of rows) urls.push({ loc: `${base}/blog/${p.slug}`, lastmod: p.updated_at });
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
    .join("\n")}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" } });
}
