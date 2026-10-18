import type { z } from "zod";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { moduleConfig } from "@/lib/site-loader";
import { publicTopupPlans } from "@/lib/services/wallet";
import { paymentAvailability, shopSettingsSchema, type ShopSettings } from "@/lib/services/shop";
import { siteHref, type RenderCtx, type SectionComponent } from "../render-types";
import { storedValueSettings, type topupPlansProps } from "./manifest";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/** 儲值方案卡片＋購買表單（會員才能買；付款方式沿用商店設定，sandbox 只限預覽） */
export async function TopupPlanCards({ ctx }: { ctx: RenderCtx }) {
  const store = getStore();
  const site = ctx.site;
  const plans = await publicTopupPlans(store, site.tenant);
  if (!plans.length) return <p className="gb-muted">儲值方案準備中。</p>;
  const member = await currentMember(site.tenant);
  const parsed = shopSettingsSchema.safeParse(moduleConfig(site, "shop"));
  const avail = await paymentAvailability(store, site.tenant, (parsed.success ? parsed.data : {}) as ShopSettings, { allowSandbox: site.mode === "preview" });
  const settings = storedValueSettings.safeParse(moduleConfig(site, "stored-value"));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3" data-gb="topup-plans">
        {plans.map((p) => (
          <div key={p.id} className="gb-card flex flex-col gap-2 p-5">
            <h3 className="m-0 text-lg font-bold">{p.name}</h3>
            <p className="m-0">
              付 <strong>{twd(p.payAmount)}</strong> 得 <strong>{twd(p.creditTotal)}</strong>
            </p>
            {p.bonusAmount > 0 && <p className="gb-muted m-0 text-sm">含贈送 {twd(p.bonusAmount)}{p.bonusExpireDays ? `（贈送額度 ${p.bonusExpireDays} 天後到期）` : ""}</p>}
            {p.description && <p className="gb-muted m-0 text-sm">{p.description}</p>}
            {member ? (
              <form method="post" action={`/s/${site.tenant.slug}/api/wallet/topup`} className="mt-2 flex flex-col gap-2 text-sm" data-gb="topup-form">
                <input type="hidden" name="planId" value={p.id} />
                {site.mode === "preview" && site.previewToken && <input type="hidden" name="preview" value={site.previewToken} />}
                <input name="name" required maxLength={80} placeholder="姓名" defaultValue={member.name ?? ""} className="gb-input" aria-label="姓名" />
                <input name="phone" required minLength={6} maxLength={40} placeholder="電話" defaultValue={member.phone ?? ""} className="gb-input" aria-label="電話" type="tel" />
                <select name="paymentMethod" className="gb-input" aria-label="付款方式">
                  {avail.offline && <option value="offline">線下匯款</option>}
                  {avail.pchomepay && <option value="pchomepay">線上付款{avail.pchomepaySandbox ? "（測試環境）" : ""}</option>}
                  {avail.online.filter((o) => o.provider !== "pchomepay").map((o) => (
                    <option key={o.provider} value={o.provider}>
                      線上付款（{o.label}）{o.sandbox ? "（測試環境）" : ""}
                    </option>
                  ))}
                </select>
                <button className="gb-btn self-start" type="submit" disabled={!avail.offline && avail.online.length === 0}>
                  購買
                </button>
              </form>
            ) : (
              <a className="gb-btn self-start" href={siteHref(ctx, "/account/login?next=/wallet")}>
                登入會員後購買
              </a>
            )}
          </div>
        ))}
      </div>
      {settings.success && settings.data.notice && <p className="gb-muted m-0 whitespace-pre-line text-sm">{settings.data.notice}</p>}
    </div>
  );
}

export const TopupPlans: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof topupPlansProps>;
  return (
    <section className="gb-section">
      <div className="gb-container">
        <h2 className="gb-h2">{p.heading ?? "儲值方案"}</h2>
        {p.intro && <p className="gb-muted">{p.intro}</p>}
        <TopupPlanCards ctx={ctx} />
      </div>
    </section>
  );
};
