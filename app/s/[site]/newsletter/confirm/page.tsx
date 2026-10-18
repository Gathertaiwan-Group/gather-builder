import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "確認訂閱", robots: { index: false }, referrer: "no-referrer" };

/** 確認頁（L-3）：GET 只顯示按鈕，按下才 POST 確認（信件掃描器預先打開連結不會替人訂閱） */
export default async function ConfirmPage(props: { params: Promise<{ site: string }>; searchParams: Promise<{ token?: string; ok?: string; err?: string }> }) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "newsletter");
  if (!site) notFound();
  return (
    <SiteShell ctx={makeRenderCtx(site, "/newsletter/confirm")}>
      <section className="gb-section">
        <div className="gb-container max-w-xl">
          <h1 className="gb-h2">電子報訂閱</h1>
          {sp.ok && (
            <p className="gb-card p-4" data-gb="newsletter-confirm" data-ok="1">
              {sp.ok}
            </p>
          )}
          {sp.err && (
            <p className="gb-card p-4" role="alert" data-gb="newsletter-confirm" data-ok="0">
              {sp.err}
            </p>
          )}
          {sp.token && !sp.ok && (
            <form method="post" action={`/s/${site.tenant.slug}/api/newsletter/confirm`} className="gb-card flex flex-col gap-3 p-4" data-gb="newsletter-confirm-form">
              <p className="m-0">確認訂閱「{site.tenant.name}」的電子報？</p>
              <input type="hidden" name="token" value={sp.token} />
              <button className="gb-btn self-start" type="submit">
                確認訂閱
              </button>
            </form>
          )}
          {!sp.token && !sp.ok && !sp.err && <p className="gb-card p-4">確認連結無效或已過期，請重新訂閱。</p>}
        </div>
      </section>
    </SiteShell>
  );
}
