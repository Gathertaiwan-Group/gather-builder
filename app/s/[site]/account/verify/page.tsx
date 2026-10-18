import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel } from "@/components/site/AccountForm";
import { getStore } from "@/lib/store";
import { verifyEmail } from "@/lib/services/members";
import { messageOf } from "@/lib/site-request";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email 驗證", robots: { index: false }, referrer: "no-referrer" };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ token?: string }> };

export default async function VerifyPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  let msg: { ok?: string; err?: string };
  try {
    msg = { ok: (await verifyEmail(getStore(), site.tenant, sp.token)).message };
  } catch (e) {
    msg = { err: messageOf(e) };
  }
  const ctx = makeRenderCtx(site, "/account/verify");
  return (
    <SiteShell ctx={ctx}>
      <AccountPanel title="Email 驗證" sp={msg}>
        <a className="gb-btn" href={siteHref(ctx, "/account")}>
          前往會員中心
        </a>
      </AccountPanel>
    </SiteShell>
  );
}
