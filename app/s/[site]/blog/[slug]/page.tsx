import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadSite, moduleActive } from "@/lib/site-loader";
import { resolveSiteSlug } from "@/lib/tenant-resolve";
import { getStore } from "@/lib/store";
import { renderMarkdown } from "@/lib/markdown";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { siteHref } from "@/modules/render-types";
import { formatDate } from "@/modules/blog/sections";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ site: string; slug: string }>; searchParams: Promise<{ preview?: string }> };

async function load(props: Props) {
  const [{ site: raw, slug: postSlug }, sp] = await Promise.all([props.params, props.searchParams]);
  const slug = resolveSiteSlug({ pathSlug: raw });
  const site = slug ? await loadSite(slug, sp.preview ?? null) : null;
  if (!site || !moduleActive(site, "blog")) return null;
  const post = await getStore().getPostBySlug(site.tenant.id, postSlug);
  // 草稿文章只在預覽模式看得到
  if (!post || (site.mode !== "preview" && (post.status !== "published" || !post.published_at || post.published_at > new Date().toISOString()))) return null;
  return { site, post };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await load(props);
  if (!r) return { title: "找不到文章" };
  return {
    title: `${r.post.title}｜${r.site.tenant.name}`,
    description: r.post.excerpt ?? undefined,
    openGraph: { title: r.post.title, description: r.post.excerpt ?? undefined, type: "article", images: r.post.cover_url ? [r.post.cover_url] : undefined },
  };
}

export default async function PostPage(props: Props) {
  const r = await load(props);
  if (!r) notFound();
  const ctx = makeRenderCtx(r.site, `/blog/${r.post.slug}`);
  return (
    <SiteShell ctx={ctx}>
      <article className="gb-section">
        <div className="gb-container max-w-3xl">
          <a href={siteHref(ctx, "/blog")} className="text-sm" style={{ color: "var(--gb-primary)" }}>
            ← 所有文章
          </a>
          <h1 className="mb-2 mt-4 text-[clamp(1.75rem,1.3rem+2vw,2.75rem)] font-bold" data-gb="post-title">
            {r.post.title}
          </h1>
          <time className="gb-muted text-sm">{formatDate(r.post.published_at)}</time>
          {r.post.cover_url && <img src={r.post.cover_url} alt="" className="my-6 w-full rounded-[var(--gb-radius)]" />}
          <div className="gb-prose mt-6" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.post.body_md) }} />
        </div>
      </article>
    </SiteShell>
  );
}
