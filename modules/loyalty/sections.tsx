import type { z } from "zod";
import { moduleConfig } from "@/lib/site-loader";
import type { SectionComponent } from "../render-types";
import { loyaltySettings, type loyaltyTiersProps } from "./manifest";
import { DEFAULT_EARN_PER_AMOUNT, DEFAULT_POINT_VALUE, DEFAULT_POINTS_EXPIRE_DAYS, sortedTiers } from "@/lib/loyalty/rules";

const twd = (n: number) => `NT$${n.toLocaleString("en-US")}`;

export const LoyaltyTiers: SectionComponent = ({ props, ctx }) => {
  const p = props as z.output<typeof loyaltyTiersProps>;
  const parsed = loyaltySettings.safeParse(moduleConfig(ctx.site, "loyalty"));
  const s = parsed.success ? parsed.data : {};
  const tiers = sortedTiers(s.tiers);
  return (
    <section className="gb-section" data-gb="loyalty-tiers">
      <div className="gb-container">
        <h2 className="gb-h2">{p.heading ?? "會員制度"}</h2>
        {p.intro && <p className="gb-muted">{p.intro}</p>}
        {p.showEarnRule && (
          <p className="m-0 mb-4">
            每消費 {twd(s.earnPerAmount ?? DEFAULT_EARN_PER_AMOUNT)} 得 1 點，1 點可折抵 {twd(s.pointValue ?? DEFAULT_POINT_VALUE)}；點數 {s.pointsExpireDays ?? DEFAULT_POINTS_EXPIRE_DAYS} 天後到期。
          </p>
        )}
        {tiers.length > 0 && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {tiers.map((t) => (
              <div key={t.id} className="gb-card p-5">
                <h3 className="m-0 text-lg font-bold">{t.name}</h3>
                <p className="gb-muted m-0 mt-1 text-sm">{t.minSpend > 0 ? `消費滿 ${twd(t.minSpend)}` : "註冊即享"}</p>
                <ul className="m-0 mt-3 flex list-disc flex-col gap-1 pl-5 text-sm">
                  {t.multiplier > 1 && <li>賺點 {t.multiplier} 倍</li>}
                  {t.discountPercent > 0 && <li>商品 {(100 - t.discountPercent) / 10} 折</li>}
                  {t.perks && <li>{t.perks}</li>}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
