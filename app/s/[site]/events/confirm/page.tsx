import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "確認報名", robots: { index: false }, referrer: "no-referrer" };

/** M5：免費報名／候補的 email 確認頁。GET 只顯示按鈕，按下才 POST（信件掃描器預先打開連結不會替人確認） */
export default async function EventConfirmPage(props: { params: Promise<{ site: string }>; searchParams: Promise<{ r?: string; w?: string; t?: string; ok?: string; err?: string }> }) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "events");
  if (!site) notFound();
  const id = sp.r ?? sp.w;
  return (
    <SiteShell ctx={makeRenderCtx(site, "/events/confirm")}>
      <section className="gb-section">
        <div className="gb-container max-w-xl">
          <h1 className="gb-h2">{sp.w ? "確認候補登記" : "確認報名"}</h1>
          {sp.ok && (
            <p className="gb-card p-4" data-gb="event-confirm" data-ok="1">
              {sp.ok}
            </p>
          )}
          {sp.err && (
            <p className="gb-card p-4" role="alert" data-gb="event-confirm" data-ok="0">
              {sp.err}
            </p>
          )}
          {id && sp.t && !sp.ok && !sp.err && (
            <form method="post" action={`/s/${site.tenant.slug}/api/events/confirm`} className="gb-card flex flex-col gap-3 p-4" data-gb="event-confirm-form">
              <p className="m-0">{sp.w ? "確認登記這個場次的候補？" : "確認報名這個場次？"}</p>
              {sp.r && <input type="hidden" name="r" value={sp.r} />}
              {sp.w && <input type="hidden" name="w" value={sp.w} />}
              <input type="hidden" name="t" value={sp.t} />
              <button className="gb-btn self-start" type="submit">
                確認
              </button>
            </form>
          )}
          {(!id || !sp.t) && !sp.ok && !sp.err && <p className="gb-card p-4">確認連結無效或已過期，請重新報名。</p>}
        </div>
      </section>
    </SiteShell>
  );
}
