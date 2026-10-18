import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { loadModulePage } from "@/lib/site-page";
import { currentMember } from "@/lib/site-request";
import { moduleActive } from "@/lib/site-loader";
import { getStore } from "@/lib/store";
import { SiteShell, makeRenderCtx } from "@/components/site/SiteShell";
import { AccountPanel, Field } from "@/components/site/AccountForm";
import { siteHref } from "@/modules/render-types";
import { ORDER_STATUS_LABEL } from "@/lib/shop/machine";
import { twd } from "@/modules/shop/sections";
import { expireIfDue } from "@/lib/services/orders";
import { INVOICE_LABEL, SHIPMENT_LABEL } from "@/lib/order-labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "會員中心", robots: { index: false } };

type Props = { params: Promise<{ site: string }>; searchParams: Promise<{ ok?: string; err?: string }> };

export default async function AccountPage(props: Props) {
  const [{ site: raw }, sp] = await Promise.all([props.params, props.searchParams]);
  const site = await loadModulePage(raw, "members");
  if (!site) notFound();
  const member = await currentMember(site.tenant);
  if (!member) redirect(`/s/${site.tenant.slug}/account/login`);
  const ctx = makeRenderCtx(site, "/account");
  const store = getStore();
  const listed = moduleActive(site, "shop") ? (await store.listOrders(site.tenant.id, { memberId: member.id, limit: 50, offset: 0 })).rows : [];
  // 逾期未付的訂單在讀取時 lazy 取消（冪等）
  const orders = await Promise.all(listed.map((o) => expireIfDue(store, o)));
  // 發票號與物流追蹤號（有啟用對應模組才有資料）
  const extras = await Promise.all(
    orders.map(async (o) => ({
      invoice: o.invoice_status ? await store.getInvoiceByOrder(site.tenant.id, o.id) : null,
      shipment: await store.getActiveShipmentByOrder(site.tenant.id, o.id),
    })),
  );
  const action = (p: string) => `/s/${site.tenant.slug}/api/account/${p}`;
  return (
    <SiteShell ctx={ctx}>
      <AccountPanel title="會員中心" sp={sp}>
        <p className="m-0 mb-4 text-sm" data-gb="member-email">
          {member.email} {member.email_verified_at ? "（已驗證）" : "（尚未驗證 Email）"}
        </p>
        <form method="post" action={action("profile")} className="gb-card mb-6 flex flex-col gap-4 p-5">
          <h2 className="m-0 text-lg font-bold">個人資料</h2>
          <Field label="姓名" name="name" defaultValue={member.name ?? ""} maxLength={80} autoComplete="name" />
          <Field label="電話" name="phone" defaultValue={member.phone ?? ""} maxLength={40} autoComplete="tel" type="tel" />
          <button className="gb-btn self-start" type="submit">
            儲存
          </button>
        </form>
        {moduleActive(site, "shop") && (
          <div className="gb-card mb-6 p-5" data-gb="my-orders">
            <h2 className="m-0 mb-3 text-lg font-bold">我的訂單</h2>
            {orders.length === 0 ? (
              <p className="gb-muted m-0 text-sm">還沒有訂單。</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {orders.map((o, i) => {
                  const inv = extras[i]?.invoice;
                  const sh = extras[i]?.shipment;
                  return (
                    <li key={o.id} className="flex flex-wrap justify-between gap-2 border-t pt-2" style={{ borderColor: "color-mix(in srgb, var(--gb-text) 10%, transparent)" }}>
                      <a href={siteHref(ctx, `/orders/${o.order_no}`)} data-gb="order-link">
                        {o.order_no}
                      </a>
                      <span>
                        {ORDER_STATUS_LABEL[o.status]} · {twd(o.total)}
                      </span>
                      {(inv?.invoice_no || sh) && (
                        <span className="gb-muted w-full text-xs">
                          {inv?.invoice_no && <span data-gb="invoice-no">發票 {inv.invoice_no}（{INVOICE_LABEL[inv.status] ?? inv.status}）</span>}
                          {inv?.invoice_no && sh && " · "}
                          {sh && (
                            <span data-gb="shipment">
                              {SHIPMENT_LABEL[sh.status] ?? sh.status}
                              {sh.tracking_no && <> · 追蹤號 <span data-gb="tracking-no">{sh.tracking_no}</span></>}
                            </span>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        <form method="post" action={action("logout")}>
          <button className="text-sm underline" type="submit" style={{ background: "none", border: 0, color: "var(--gb-text)", cursor: "pointer" }}>
            登出
          </button>
        </form>
      </AccountPanel>
    </SiteShell>
  );
}
