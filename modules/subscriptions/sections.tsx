import type { z } from "zod";
import { getStore } from "@/lib/store";
import { currentMember } from "@/lib/site-request";
import { moduleConfig } from "@/lib/site-loader";
import { publicSubscriptionPlans } from "@/lib/services/subscriptions";
import { siteHref, type SectionComponent } from "../render-types";
import type { SubscriptionsSettings, subscriptionPlansProps } from "./manifest";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

/** 訂閱方案（只列上架中的）；會員登入後送出 → 伺服器回藍新定期定額表單（自動送出）。預覽模式帶簽章（sandbox 只限預覽） */
export const SubscriptionPlans: SectionComponent = async ({ props, ctx }) => {
  const p = props as z.output<typeof subscriptionPlansProps>;
  const { site } = ctx;
  const [plans, member] = await Promise.all([publicSubscriptionPlans(getStore(), site.tenant), currentMember(site.tenant)]);
  const settings = moduleConfig<SubscriptionsSettings>(site, "subscriptions");
  return (
    <section className="gb-section" data-gb="subscription-plans">
      <div className="gb-container">
        {p.heading && <h2 className="gb-h2">{p.heading}</h2>}
        {p.intro && <p className="gb-muted">{p.intro}</p>}
        {!plans.length ? (
          <p className="gb-muted">目前沒有開放的方案。</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {plans.map((plan) => (
              <div key={plan.id} className="gb-card flex flex-col gap-2 p-5">
                <h3 className="m-0 text-lg font-bold">{plan.name}</h3>
                <p className="m-0">
                  <strong>{twd(plan.amount)}</strong> / {plan.interval === "month" ? "每月" : "每年"}
                </p>
                {plan.trialDays > 0 && <p className="gb-muted m-0 text-sm">前 {plan.trialDays} 天試用（先做 NT$10 信用卡驗證，試用期後才扣第一期）</p>}
                {plan.description && <p className="gb-muted m-0 whitespace-pre-line text-sm">{plan.description}</p>}
                {member ? (
                  <form method="post" action={`/s/${site.tenant.slug}/api/subscriptions/subscribe`} className="mt-2">
                    <input type="hidden" name="planId" value={plan.id} />
                    {site.mode === "preview" && site.previewToken && <input type="hidden" name="preview" value={site.previewToken} />}
                    <button className="gb-btn" type="submit">
                      信用卡訂閱
                    </button>
                  </form>
                ) : (
                  <a className="gb-btn self-start" href={siteHref(ctx, "/account/login?next=/account")}>
                    登入會員後訂閱
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
        {settings.notice && <p className="gb-muted mt-4 whitespace-pre-line text-sm">{settings.notice}</p>}
        <p className="gb-muted mt-2 text-xs">定期扣款由藍新金流處理，本站不會經手你的卡號；可隨時在會員中心取消，權益保留到已付期間結束。</p>
      </div>
    </section>
  );
};
