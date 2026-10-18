import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel, Field } from "@/components/site/AccountForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "忘記密碼", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ ok?: string; err?: string }> };

export default async function ForgotPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  return (
    <SiteShell ctx={makeRenderCtx(site, "/account/forgot")}>
      <AccountPanel title="忘記密碼" sp={sp}>
        <form method="post" action={`/s/${site.tenant.slug}/api/account/forgot`} className="gb-card flex flex-col gap-4 p-5">
          <Field label="註冊時的 Email" name="email" type="email" required autoComplete="email" maxLength={254} />
          <button className="gb-btn" type="submit">
            寄送重設連結
          </button>
        </form>
      </AccountPanel>
    </SiteShell>
  );
}
