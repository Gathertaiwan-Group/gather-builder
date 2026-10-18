import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { moduleActive, moduleConfig } from "@/lib/site-loader";
import { invoiceSettings } from "@/modules/invoice/manifest";
import { shippingSettings } from "@/modules/shipping/manifest";
import { availableShippingMethods, cvsCookieName, selectionForBrowser } from "@/lib/services/shipping";
import { cookies } from "next/headers";
import { currentMember } from "@/lib/site-request";
import { getStore } from "@/lib/store";
import { paymentAvailability, shopSettingsSchema, type ShopSettings } from "@/lib/services/shop";
import { PCHOMEPAY_MIN_AMOUNT } from "@/lib/pay/pchomepay";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { CheckoutClient } from "@/modules/shop/CheckoutClient";
import { siteHref } from "@/modules/render-types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "購物車與結帳", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ err?: string; preview?: string; cvs?: string }> };

export default async function CheckoutPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "shop", sp.preview);
  if (!site) notFound();
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  const settings = (parsed.success ? parsed.data : {}) as ShopSettings;
  const [member, avail] = await Promise.all([currentMember(site.tenant), paymentAvailability(getStore(), site.tenant, settings, { allowSandbox: site.mode === "preview" })]);
  const ctx = makeRenderCtx(site, "/checkout");
  const allowStage = site.mode === "preview";
  const shipSettings = moduleActive(site, "shipping") ? shippingSettings.safeParse(moduleConfig(site, "shipping")) : null;
  const shippingMethods = shipSettings?.success
    ? (await availableShippingMethods(getStore(), site.tenant, shipSettings.data, { allowStage })).map((m) => ({ id: m.id, type: m.type, label: m.label, fee: m.fee, freeThreshold: m.freeThreshold ?? null, instructions: m.instructions ?? null }))
    : null;
  const binding = (await cookies()).get(cvsCookieName(site.tenant.id))?.value;
  const cvsSelection = shippingMethods ? await selectionForBrowser(getStore(), site.tenant, sp.cvs, binding) : null;
  const inv = moduleActive(site, "invoice") ? invoiceSettings.safeParse(moduleConfig(site, "invoice")) : null;
  const invoiceOptions = inv?.success
    ? { mobile: inv.data.allowMobileBarcode !== false, certificate: inv.data.allowCertificate !== false, donation: inv.data.allowDonation !== false, b2b: inv.data.allowB2B !== false, defaultLoveCode: inv.data.defaultLoveCode ?? null }
    : inv
      ? { mobile: true, certificate: true, donation: true, b2b: true, defaultLoveCode: null }
      : null;
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
              invoiceOptions={invoiceOptions}
              shippingMethods={shippingMethods}
              cvsSelection={cvsSelection}
              cvsStartAction={`/s/${slug}/api/shipping/cvs-start`}
              couponsEnabled={moduleActive(site, "coupons")}
              minOnline={PCHOMEPAY_MIN_AMOUNT}
            />
          )}
        </div>
      </section>
    </SiteShell>
  );
}
