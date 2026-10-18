import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel, Field } from "@/components/site/AccountForm";

export const dynamic = "force-dynamic";
// 網址含一次性 token：不收錄、不帶 referrer
export const metadata: Metadata = { title: "重設密碼", robots: { index: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ ok?: string; err?: string; token?: string }> };

export default async function ResetPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  return (
    <SiteShell ctx={makeRenderCtx(site, "/account/reset")}>
      <AccountPanel title="設定新密碼" sp={sp}>
        {sp.token ? (
          <form method="post" action={`/s/${site.tenant.slug}/api/account/reset`} className="gb-card flex flex-col gap-4 p-5">
            <input type="hidden" name="token" value={sp.token} />
            <Field label="新密碼（至少 8 碼）" name="password" type="password" required autoComplete="new-password" minLength={8} maxLength={200} />
            <button className="gb-btn" type="submit">
              更新密碼
            </button>
          </form>
        ) : (
          <p className="gb-muted">連結無效或已過期，請重新申請。</p>
        )}
      </AccountPanel>
    </SiteShell>
  );
}
