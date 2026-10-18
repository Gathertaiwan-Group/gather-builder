import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { moduleConfig } from "@/lib/site-loader";
import { currentMember } from "@/lib/site-request";
import { getStore } from "@/lib/store";
import { paymentAvailability, shopSettingsSchema, type ShopSettings } from "@/lib/services/shop";
import { PCHOMEPAY_MIN_AMOUNT } from "@/lib/pay/pchomepay";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { CheckoutClient } from "@/modules/shop/CheckoutClient";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "購物車與結帳", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ err?: string; preview?: string }> };

export default async function CheckoutPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "shop", sp.preview);
  if (!site) notFound();
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  const settings = (parsed.success ? parsed.data : {}) as ShopSettings;
  const [member, avail] = await Promise.all([currentMember(site.tenant), paymentAvailability(getStore(), site.tenant, settings, { allowSandbox: site.mode === "preview" })]);
  const ctx = makeRenderCtx(site, "/checkout");
  const slug = site.tenant.slug;
  return (
    <SiteShell ctx={ctx}>
      <section className="gb-section">
        <div className="gb-container max-w-3xl">
          <h1 className="gb-h2">購物車與結帳</h1>
          {sp.err && (
            <p role="alert" className="mb-4 rounded p-3 text-sm" style={{ background: "#fef2f2", color: "#991b1b" }} data-gb="err">
              {sp.err}
            </p>
          )}
          {settings.allowGuestCheckout === false && !member ? (
            <p>
              此商店需要先 <a href={siteHref(ctx, "/account/login?next=/checkout")}>登入會員</a> 才能結帳。
            </p>
          ) : (
            <CheckoutClient
              slug={slug}
              quoteUrl={`/s/${slug}/api/shop/quote`}
              action={`/s/${slug}/api/shop/checkout`}
              shopHref={siteHref(ctx, "/shop")}
              member={member ? { name: member.name ?? "", email: member.email, phone: member.phone ?? "" } : null}
              loginHref={siteHref(ctx, "/account/login?next=/checkout")}
              methods={{ pchomepay: avail.pchomepay, atm: avail.pchomepayAtm, offline: avail.offline, offlineInstructions: avail.offlineInstructions, sandbox: avail.pchomepaySandbox }}
              previewToken={site.mode === "preview" ? site.previewToken : null}
              minOnline={PCHOMEPAY_MIN_AMOUNT}
            />
          )}
        </div>
      </section>
    </SiteShell>
  );
}
