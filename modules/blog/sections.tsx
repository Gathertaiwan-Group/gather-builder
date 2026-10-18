import type { z } from "zod";
import { localizeRow, localizeRows } from "@/lib/services/i18n";
import { getStore } from "@/lib/store";
import { siteHref, type SectionComponent } from "../render-types";
import type { postsListProps } from "./manifest";

export function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Taipei" });
}

export const PostsList: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof postsListProps>;
  const listed = await getStore().listPosts(ctx.site.tenant.id, {
    status: "published",
    limit: p.limit,
    offset: 0,
    publishedBefore: new Date().toISOString(),
  });
  const rows = await localizeRows(getStore(), ctx.site, "post", listed.rows);
  return (
    <section className="gb-section">
      <div className="gb-container">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
          <h2 className="gb-h2 m-0">{p.heading ?? "最新文章"}</h2>
          <a href={siteHref(ctx, "/blog")} className="text-sm" style={{ color: "var(--gb-primary)" }}>
            全部文章 →
          </a>
        </div>
        {rows.length === 0 ? (
          <p className="gb-muted">目前還沒有文章。</p>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            {rows.map((post) => (
              <a key={post.id} href={siteHref(ctx, `/blog/${post.slug}`)} className="gb-card block overflow-hidden text-inherit no-underline" data-gb="post-card">
                {post.cover_url && <img src={post.cover_url} alt="" loading="lazy" className="aspect-[16/9] w-full object-cover" />}
                <div className="p-5">
                  <time className="gb-muted text-xs">{formatDate(post.published_at)}</time>
                  <h3 className="m-0 mt-1 text-lg font-bold">{post.title}</h3>
                  {p.showExcerpt && post.excerpt && <p className="gb-muted mb-0 mt-2 text-sm leading-relaxed">{post.excerpt}</p>}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
