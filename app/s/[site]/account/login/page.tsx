import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { currentMember, safeNext } from "@/lib/site-request";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel, Field } from "@/components/site/AccountForm";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "會員登入", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ ok?: string; err?: string; next?: string }> };

export default async function LoginPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  if (await currentMember(site.tenant)) redirect(`/s/${site.tenant.slug}/account`);
  const ctx = makeRenderCtx(site, "/account/login");
  return (
    <SiteShell ctx={ctx}>
      <AccountPanel title="會員登入" sp={sp}>
        <form method="post" action={`/s/${site.tenant.slug}/api/account/login`} className="gb-card flex flex-col gap-4 p-5" data-gb="login-form">
          <input type="hidden" name="next" value={safeNext(sp.next, "/account")} />
          <Field label="Email" name="email" type="email" required autoComplete="email" maxLength={254} />
          <Field label="密碼" name="password" type="password" required autoComplete="current-password" minLength={8} maxLength={200} />
          <button className="gb-btn" type="submit">
            登入
          </button>
        </form>
        <p className="mt-4 flex flex-wrap gap-4 text-sm">
          <a href={siteHref(ctx, "/account/register")}>註冊新帳號</a>
          <a href={siteHref(ctx, "/account/forgot")}>忘記密碼</a>
        </p>
      </AccountPanel>
    </SiteShell>
  );
}
