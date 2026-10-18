import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel, Field } from "@/components/site/AccountForm";
import { siteHref } from "@/modules/render-types";
import { moduleConfig } from "@/lib/site-loader";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "註冊會員", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ ok?: string; err?: string }> };

export default async function RegisterPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  const ctx = makeRenderCtx(site, "/account/register");
  const closed = moduleConfig<{ allowRegistration?: boolean }>(site, "members").allowRegistration === false;
  return (
    <SiteShell ctx={ctx}>
      <AccountPanel title="註冊會員" sp={sp}>
        {closed ? (
          <p className="gb-muted">此網站目前不開放註冊。</p>
        ) : (
          <form method="post" action={`/s/${site.tenant.slug}/api/account/register`} className="gb-card flex flex-col gap-4 p-5" data-gb="register-form">
            <Field label="Email" name="email" type="email" required autoComplete="email" maxLength={254} />
            <Field label="密碼（至少 8 碼）" name="password" type="password" required autoComplete="new-password" minLength={8} maxLength={200} />
            <Field label="姓名（選填）" name="name" autoComplete="name" maxLength={80} />
            <Field label="電話（選填）" name="phone" type="tel" autoComplete="tel" maxLength={40} />
            <button className="gb-btn" type="submit">
              註冊
            </button>
          </form>
        )}
        <p className="mt-4 text-sm">
          已經有帳號？<a href={siteHref(ctx, "/account/login")}>登入</a>
        </p>
      </AccountPanel>
    </SiteShell>
  );
}
